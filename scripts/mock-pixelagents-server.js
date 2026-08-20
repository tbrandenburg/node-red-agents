#!/usr/bin/env node
// Usage: node mock-pixelagents-server.js [port] [authToken]
//
// Used by the "Agentic Development Team" flow's dev fallback (see the
// "set global.pixelAgents (with dev fallback)" function node in
// demo/flows.json) when ~/.pixel-agents/server.json isn't present, so the
// pixel-agents notify chain can be exercised without the real pixel-agents
// CLI installed. GET /__events returns everything received so far, for
// test assertions.
// Minimal mock of the pixel-agents standalone server, just enough to verify
// Node-RED's fire-and-forget POST /api/hooks/web calls: checks Bearer auth,
// logs every accepted hook event, replies "ok".
"use strict";

const http = require("http");

const PORT = Number(process.argv[2] || 3100);
const TOKEN = process.argv[3] || "mock-token-for-dev";

const events = [];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime(), pid: process.pid }));
      return;
    }

    if (req.method === "GET" && req.url === "/__events") {
      // Test-only introspection endpoint (not part of the real pixel-agents API).
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(events));
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/api/hooks/")) {
      const providerId = req.url.slice("/api/hooks/".length);
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${TOKEN}`) {
        console.log(`[mock-pixelagents] REJECT (bad/missing auth): ${auth}`);
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      let event;
      try {
        event = JSON.parse(body || "{}");
      } catch (err) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad json");
        return;
      }
      console.log(
        `[mock-pixelagents] provider=${providerId} hook_event_name=${event.hook_event_name} session_id=${event.session_id} tool=${event.tool_name || ""} tool_id=${event.tool_id || ""}`,
      );
      events.push({ receivedAt: new Date().toISOString(), providerId, event });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-pixelagents] listening on http://127.0.0.1:${PORT} (token=${TOKEN})`);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
