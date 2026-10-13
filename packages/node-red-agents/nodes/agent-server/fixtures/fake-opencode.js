#!/usr/bin/env node
"use strict";

// Stand-in for the real `opencode` binary's `serve` subcommand, used only in
// tests -- just enough surface (accepts the same `serve --port <p>
// --hostname <h>` argv shape, serves GET /global/health, POST /session and
// POST /session/:id/message) to exercise both lib/daemon.js's
// spawn/health-poll/kill logic and agent-server.js's own spawn/send-message
// flow without depending on the real opencode binary being installed.
const http = require("http");
const { createHash } = require("node:crypto");

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

let sessionCounter = 0;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === "/global/health") {
    if (process.env.FAKE_OPENCODE_AUTH_FAILURE === "1") {
      res.statusCode = 503;
      res.end(process.env.OPENROUTER_API_KEY);
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ healthy: true, version: "fake" }));
    return;
  }

  if (req.method === "POST" && req.url === "/session") {
    sessionCounter += 1;
    // Includes the port (unique per spawned daemon process) so two
    // separate fake daemons spawned in the same test never collide on
    // the same sessionID -- unlike the real opencode server, this
    // fixture's own counter starts back at 0 in every fresh child
    // process, and agent-server.js's InstanceRegistry is keyed by
    // sessionID alone.
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: `fake-session-${port}-${sessionCounter}` }));
    return;
  }

  const messageMatch = req.method === "POST" && req.url.match(/^\/session\/([^/]+)\/message$/);
  if (messageMatch) {
    readJsonBody(req)
      .then((body) => {
        if (body.parts?.[0]?.text === "auth-error") {
          res.statusCode = 500;
          res.end(process.env.OPENROUTER_API_KEY);
          return;
        }
        if (body.parts?.[0]?.text === "auth-test") {
          const key = process.env.OPENROUTER_API_KEY || "no-key";
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              parts: [
                {
                  type: "text",
                  text: JSON.stringify({
                    digest: createHash("sha256").update(key).digest("hex"),
                    echo: key,
                    model: body.model,
                  }),
                },
              ],
            }),
          );
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ parts: [{ type: "text", text: "hello from fake session" }] }));
      })
      .catch(() => {
        res.statusCode = 400;
        res.end();
      });
    return;
  }

  res.statusCode = 404;
  res.end();
});

server.listen(port, hostname, () => {
  if (process.env.FAKE_OPENCODE_AUTH_FAILURE === "1") {
    const key = process.env.OPENROUTER_API_KEY || "no-key";
    process.stderr.write(key.slice(0, 8));
    setImmediate(() => process.stderr.write(key.slice(8)));
  }
  console.log(`opencode server listening on http://${hostname}:${port}`);
});
