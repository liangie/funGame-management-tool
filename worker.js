
export default {
    async fetch(request, env) {
        // 1. Handle CORS Preflight
        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, X-Auth-Password",
                },
            });
        }

        // ==========================================
        // Auth Check & Mode Selection
        // ==========================================
        const password = request.headers.get("X-Auth-Password");
        const isAdmin = (password === env.ACCESS_PASSWORD && !!env.ACCESS_PASSWORD);

        // Helper to determine Gist ID based on filename
        const getGistIdForFile = (filename) => {
            if (filename === "LevelCfg.json") return env.LEVEL_CFG_GIST_ID;
            return env.GIST_ID; // Default to Series Config
        };

        // ==========================================
        // Mode A: Admin Mode (Authenticated)
        // Preserves original Management Tool functionality
        // ==========================================
        if (isAdmin) {
            // 2. Allow GET and POST
            if (request.method !== "POST" && request.method !== "GET") {
                return new Response("Method not allowed", { status: 405 });
            }

            // 4. Handle GET (Read)
            if (request.method === "GET") {
                try {
                    const url = new URL(request.url);
                    const requestedFile = url.searchParams.get("file"); // e.g. "LevelCfg.json"

                    // Determine which Gist to fetch
                    const targetGistId = getGistIdForFile(requestedFile);
                    if (!targetGistId) throw new Error(`Gist ID not configured for ${requestedFile || "Default"}`);

                    const githubResp = await fetch(`https://api.github.com/gists/${targetGistId}`, {
                        method: "GET",
                        headers: {
                            "Authorization": `token ${env.GITHUB_TOKEN}`,
                            "User-Agent": "Cloudflare-Worker-Proxy",
                            "Accept": "application/vnd.github.v3+json"
                        }
                    });

                    if (!githubResp.ok) throw new Error(`GitHub API Error: ${githubResp.status}`);

                    const gistJson = await githubResp.json();
                    const files = gistJson.files;
                    let targetFile;

                    if (requestedFile && files[requestedFile]) {
                        targetFile = files[requestedFile];
                    } else {
                        // Fallback logic
                        targetFile = files["SeriesLocaleCfg.json"] || Object.values(files)[0];
                    }

                    if (!targetFile) throw new Error("File not found in Gist");

                    return new Response(targetFile.content, {
                        headers: {
                            "Content-Type": "application/json",
                            "Access-Control-Allow-Origin": "*"
                        }
                    });

                } catch (err) {
                    return new Response(JSON.stringify({ error: err.message }), {
                        status: 500,
                        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
                    });
                }
            }

            // 5. Handle POST (Write - Update Gist)
            // STRICT: Only allow updating the MAIN Gist (SeriesCfg). LevelCfg is Read-Only.
            if (request.method === "POST") {
                try {
                    const data = await request.json();
                    const filesPayload = data.files || {};

                    // Filter out any files that are NOT for the main Gist
                    const mainGistPayload = { files: {} };
                    let hasUpdates = false;

                    for (const [filename, fileData] of Object.entries(filesPayload)) {
                        // If it's LevelCfg using the secondary ID, SKIP IT (Read Only)
                        if (getGistIdForFile(filename) !== env.GIST_ID) {
                            continue;
                        }
                        mainGistPayload.files[filename] = fileData;
                        hasUpdates = true;
                    }

                    if (!hasUpdates) {
                        return new Response(JSON.stringify({ message: "No allowed files to update for the main Gist." }), {
                            status: 200, // Not an error, just nothing happened
                            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
                        });
                    }

                    const githubResp = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
                        method: "PATCH",
                        headers: {
                            "Authorization": `token ${env.GITHUB_TOKEN}`,
                            "User-Agent": "Cloudflare-Worker-Proxy",
                            "Content-Type": "application/json",
                            "Accept": "application/vnd.github.v3+json"
                        },
                        body: JSON.stringify(mainGistPayload)
                    });

                    const responseBody = await githubResp.json();

                    return new Response(JSON.stringify(responseBody), {
                        status: githubResp.status,
                        headers: {
                            "Content-Type": "application/json",
                            "Access-Control-Allow-Origin": "*"
                        }
                    });

                } catch (err) {
                    return new Response(JSON.stringify({ error: err.message }), {
                        status: 500,
                        headers: {
                            "Content-Type": "application/json",
                            "Access-Control-Allow-Origin": "*"
                        }
                    });
                }
            }
        }

        // ==========================================
        // Mode B: Client Mode (Public, Read-Only)
        // For Game Client Locale Detection
        // ==========================================
        else {
            if (request.method !== "GET") {
                return new Response("Method not allowed (Public only supports GET)", { status: 405 });
            }

            // Only allow fetching SeriesLocaleCfg.json for public clients
            // We do NOT expose LevelCfg publicly via this worker to save bandwidth/complexity, 
            // unless required. Assuming Game Client only needs SeriesCfg for now.

            try {
                // Fetch Main Gist
                const githubResp = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
                    method: "GET",
                    headers: {
                        "Authorization": `token ${env.GITHUB_TOKEN}`,
                        "User-Agent": "Cloudflare-Worker-Proxy",
                        "Accept": "application/vnd.github.v3+json"
                    },
                    // Cache heavily for public requests to avoid hitting rate limits
                    cf: { cacheTtl: 300, cacheEverything: true }
                });

                if (!githubResp.ok) throw new Error(`GitHub API Error: ${githubResp.status}`);

                const gistJson = await githubResp.json();
                const file = gistJson.files["SeriesLocaleCfg.json"];

                if (!file) throw new Error("SeriesLocaleCfg.json not found");

                const fullData = JSON.parse(file.content);

                // --- Locale Detection Logic ---
                const country = request.cf?.country || "XX";
                let configKey = "base_global"; // Default

                if (fullData.mapping) {
                    if (fullData.mapping[country]) {
                        configKey = fullData.mapping[country];
                    } else if (fullData.mapping["default"]) {
                        configKey = fullData.mapping["default"];
                    }
                }

                const specificConfig = fullData.configs ? fullData.configs[configKey] : null;

                if (!specificConfig) return new Response("Config invalid or not found", { status: 500 });

                // Return Optimized JSON
                const clientResponse = {
                    detected_country: country,
                    used_config_key: configKey,
                    data: specificConfig
                };

                return new Response(JSON.stringify(clientResponse), {
                    headers: {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                        "X-Detected-Country": country
                    }
                });

            } catch (err) {
                // Return generic error for public
                return new Response(`Worker Error: ${err.message}`, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
            }
        }
    }
};
