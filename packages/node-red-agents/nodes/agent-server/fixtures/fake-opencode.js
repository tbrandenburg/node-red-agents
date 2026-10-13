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
let promptCounter = 0;
let latestMessages = [];

function reply(text) {
  const parts =
    text === "envelope-error" ? [] : [{ type: "text", text: "hello from fake session" }];
  const error = text.startsWith("envelope-error")
    ? {
        name: "APIError",
        data: {
          message: "synthetic-private-message",
          statusCode: 401,
          isRetryable: false,
          responseHeaders: { authorization: "synthetic-private-header" },
          responseBody: "synthetic-private-body",
          cause: "synthetic-private-cause",
        },
      }
    : undefined;
  return { parts, error };
}

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
  if (req.url === "/api/info") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ version: "2.0.18", pid: process.pid }));
    return;
  }

  if (req.url.startsWith("/api/session")) {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/api/session") {
      sessionCounter += 1;
      res.end(JSON.stringify({ data: { id: `fake-session-${port}-${sessionCounter}` } }));
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/prompt")) {
      readJsonBody(req)
        .then((body) => {
          promptCounter += 1;
          const user = { id: `msg-user-${promptCounter}`, type: "user" };
          const response = reply(body.text);
          latestMessages = [
            {
              id: `msg-assistant-${promptCounter}`,
              type: "assistant",
              time: { completed: Date.now() },
              content: response.parts,
              error: response.error
                ? {
                    type: response.error.name,
                    message: response.error.data.message,
                    status: response.error.data.statusCode,
                  }
                : undefined,
            },
            user,
          ];
          res.end(JSON.stringify({ data: user }));
        })
        .catch(() => res.writeHead(400).end());
      return;
    }
    if (req.method === "GET" && req.url.endsWith("/message")) {
      res.end(JSON.stringify({ data: latestMessages }));
      return;
    }
    res.writeHead(204).end();
    return;
  }
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
        if (body.parts?.[0]?.text?.startsWith("envelope-error")) {
          const response = reply(body.parts[0].text);
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              info: { role: "assistant", error: response.error },
              parts: response.parts,
            }),
          );
          return;
        }
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
