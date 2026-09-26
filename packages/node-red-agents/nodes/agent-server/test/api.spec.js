"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const api = require("../lib/api");

async function withServer(handler, run) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("v2 API unwraps data envelopes and sends API routes", async () => {
  const calls = [];
  const bodies = [];
  await withServer(
    async (req, res) => {
      calls.push({ method: req.method, url: req.url });
      let body = "";
      for await (const chunk of req) body += chunk;
      if (body) bodies.push({ url: req.url, body: JSON.parse(body) });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/info") res.end(JSON.stringify({ version: "2.0.18", pid: process.pid }));
      else if (req.url === "/api/session") res.end(JSON.stringify({ data: { id: "ses_test" } }));
      else if (req.url.endsWith("/prompt"))
        res.end(JSON.stringify({ data: { id: "msg_prompt", type: "user" } }));
      else if (req.url.endsWith("/message")) res.end(JSON.stringify({ data: [] }));
      else if (req.url.endsWith("/agent") || req.url.endsWith("/model")) res.writeHead(204).end();
      else res.end(JSON.stringify({ interrupted: true }));
    },
    async (baseUrl) => {
      assert.deepEqual(await api.health(baseUrl), { version: "2.0.18", pid: process.pid });
      assert.deepEqual(await api.createSession(baseUrl, "test"), { id: "ses_test" });
      await api.switchAgent(baseUrl, "ses_test", "build");
      await api.switchModel(baseUrl, "ses_test", { providerID: "acme", modelID: "model-x" });
      assert.deepEqual(await api.prompt(baseUrl, "ses_test", "hello"), {
        id: "msg_prompt",
        type: "user",
      });
      assert.deepEqual(await api.messages(baseUrl, "ses_test"), []);
      assert.deepEqual(await api.abort(baseUrl, "ses_test"), { interrupted: true });
    },
  );
  assert.deepEqual(calls, [
    { method: "GET", url: "/api/info" },
    { method: "POST", url: "/api/session" },
    { method: "POST", url: "/api/session/ses_test/agent" },
    { method: "POST", url: "/api/session/ses_test/model" },
    { method: "POST", url: "/api/session/ses_test/prompt" },
    { method: "GET", url: "/api/session/ses_test/message" },
    { method: "POST", url: "/api/session/ses_test/interrupt" },
  ]);
  assert.deepEqual(bodies, [
    { url: "/api/session", body: { title: "test" } },
    { url: "/api/session/ses_test/agent", body: { agent: "build" } },
    {
      url: "/api/session/ses_test/model",
      body: { model: { providerID: "acme", id: "model-x" } },
    },
    { url: "/api/session/ses_test/prompt", body: { text: "hello" } },
  ]);
});

test("v2 health rejects HTML and completion polling returns the finished assistant message", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/api/info") {
        res.setHeader("content-type", "text/html");
        res.end("<html></html>");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              id: "msg_assistant",
              type: "assistant",
              time: { completed: Date.now() },
              content: [{ type: "text", text: "done" }],
            },
            { id: "msg_user", type: "user", text: "prompt" },
          ],
        }),
      );
    },
    async (baseUrl) => {
      await assert.rejects(api.health(baseUrl), /unexpected response/);
      const message = await api.waitForCompletion(baseUrl, "ses_test", "msg_user", {
        timeoutMs: 1000,
      });
      assert.equal(message.content[0].text, "done");
    },
  );
});

test("v2 completion polling respects its deadline", async () => {
  await withServer(
    (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [] }));
    },
    async (baseUrl) => {
      await assert.rejects(
        api.waitForCompletion(baseUrl, "ses_test", "msg_user", { timeoutMs: 200 }),
        /did not complete within 200ms/,
      );
    },
  );
});
