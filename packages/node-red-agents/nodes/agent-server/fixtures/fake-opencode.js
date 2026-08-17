#!/usr/bin/env node
"use strict";

// Stand-in for the real `opencode` binary's `serve` subcommand, used only in
// tests -- just enough surface (accepts the same `serve --port <p>
// --hostname <h>` argv shape, serves GET /global/health) to exercise
// lib/daemon.js's spawn/health-poll/kill logic without depending on the real
// opencode binary being installed.
const http = require("http");

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const port = Number(flag("--port"));
const hostname = flag("--hostname") || "127.0.0.1";

if (process.env.FAKE_OPENCODE_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
}

const server = http.createServer((req, res) => {
  if (req.url === "/global/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ healthy: true, version: "fake" }));
    return;
  }
  res.statusCode = 404;
  res.end();
});

server.listen(port, hostname, () => {
  console.log(`opencode server listening on http://${hostname}:${port}`);
});
