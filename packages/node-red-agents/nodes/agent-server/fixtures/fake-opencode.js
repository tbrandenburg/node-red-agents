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
if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_OPENCODE_VERSION || "1.0.0"}\n`);
  return;
}
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
let blockPoll = false;
let pollPages = [];
let recoveryMode;
let activeUser;

function finishInterrupted() {
  latestMessages.unshift({
    id: `msg-interrupt-${promptCounter}`,
    type: "idle",
    outcome: "interrupted",
  });
  activeUser = undefined;
  blockPoll = false;
}

function holdResponse(stage) {
  // A readiness marker proves the real HTTP handler admitted the blocked request.
  process.stdout.write(`fake-opencode: blocked ${stage}\n`);
}

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
  if (process.env.FAKE_OPENCODE_CHECK_AUTH === "1" && req.url.startsWith("/api/")) {
    const password = process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD;
    const expected = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
    if (req.headers.authorization !== expected) {
      res.writeHead(401).end();
      return;
    }
  }
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
          if (body.id !== undefined && !/^msg_/.test(body.id)) {
            res.writeHead(400).end();
            return;
          }
          if (activeUser) {
            res.writeHead(409).end(JSON.stringify({ message: "synthetic-private-busy" }));
            return;
          }
          if (body.text === "block-prompt") {
            holdResponse("prompt");
            return;
          }
          promptCounter += 1;
          blockPoll = body.text === "block-poll";
          const user = { id: body.id || `msg-user-${promptCounter}`, type: "user" };
          recoveryMode = body.text.startsWith("s4-") ? body.text : undefined;
          if (recoveryMode && recoveryMode !== "s4-lost-completed") {
            activeUser = user;
            latestMessages.unshift(user);
            blockPoll = true;
            if (recoveryMode === "s4-lost-admission") {
              req.socket.destroy();
              return;
            }
            if (["s4-stalled-admission", "s4-delayed-admission"].includes(recoveryMode)) {
              res.writeHead(200);
              res.write('{"data":');
              if (recoveryMode === "s4-delayed-admission") {
                setTimeout(() => res.end(JSON.stringify(user) + "}"), 350);
              }
              holdResponse("admission-body");
              return;
            }
            res.end(JSON.stringify({ data: user }));
            return;
          }
          const response = reply(body.text);
          const previous = latestMessages;
          const outcome =
            body.text === "s3-interrupted"
              ? "interrupted"
              : response.error
                ? "failed"
                : "succeeded";
          latestMessages = [
            {
              id: `msg-idle-${promptCounter}`,
              type: "idle",
              outcome,
              error: response.error
                ? { type: response.error.name, status: response.error.data.statusCode }
                : undefined,
            },
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
            ...previous,
          ];
          pollPages = [];
          if (body.text === "s6-long-turn") {
            latestMessages.splice(
              2,
              0,
              ...Array.from({ length: 60 }, (_, index) => ({
                id: `msg-long-${promptCounter}-${index}`,
                type: "assistant",
                time: { completed: Date.now() },
                content: [],
              })),
            );
          }
          if (body.text === "s3-multi-step") {
            latestMessages[1].content = [{ type: "text", text: "final multi-step answer" }];
            const tool = {
              id: `msg-tool-${promptCounter}`,
              type: "assistant",
              time: { completed: Date.now() },
              finish: "tool-calls",
              content: [{ type: "text", text: "intermediate tool step" }],
            };
            latestMessages.splice(2, 0, tool);
            pollPages = [
              [user, ...previous],
              [tool, user, ...previous],
            ];
          }
          if (recoveryMode === "s4-lost-completed") {
            req.socket.destroy();
            return;
          }
          res.end(JSON.stringify({ data: user }));
        })
        .catch(() => res.writeHead(400).end());
      return;
    }
    if (req.method === "GET" && req.url.split("?")[0].endsWith("/message")) {
      if (blockPoll) {
        holdResponse("poll");
        return;
      }
      const url = new URL(req.url, "http://localhost");
      const offset = Number(url.searchParams.get("cursor") || 0);
      const timeline = pollPages.shift() || latestMessages;
      res.end(
        JSON.stringify({
          data: timeline.slice(offset, offset + 50),
          cursor: { next: timeline.length > offset ? String(offset + 50) : null, previous: null },
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/interrupt")) {
      if (recoveryMode === "s4-interrupt-failure") {
        res.writeHead(500).end(JSON.stringify({ message: "synthetic-private-interrupt" }));
        return;
      }
      if (recoveryMode === "s4-interrupt-stalled-body") {
        res.writeHead(200);
        res.write('{"interrupted":');
        holdResponse("interrupt-body");
        return;
      }
      if (recoveryMode === "s4-unconfirmed-idle") {
        res.end(JSON.stringify({ interrupted: true }));
        return;
      }
      if (activeUser) {
        holdResponse("interrupt");
        setTimeout(() => {
          finishInterrupted();
          res.end(JSON.stringify({ interrupted: true }));
        }, 100);
        return;
      }
      res.end(JSON.stringify({ interrupted: false }));
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
        if (body.parts?.[0]?.text === "block-message") {
          holdResponse("message");
          return;
        }
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
