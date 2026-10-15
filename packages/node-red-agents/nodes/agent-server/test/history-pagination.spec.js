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
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function reply(res, data, next = null) {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data, cursor: { previous: null, next } }));
}

test("v2 history traverses opaque next cursors, preserves descending order and stops at an empty page", async () => {
  const entries = Array.from({ length: 65 }, (_, index) => ({ id: `msg_${65 - index}` }));
  const calls = [];
  await withServer(
    (req, res) => {
      calls.push(req.url);
      const cursor = new URL(req.url, "http://localhost").searchParams.get("cursor");
      if (!cursor) return reply(res, entries.slice(0, 50), "opaque+/=&");
      if (cursor === "opaque+/=&") return reply(res, entries.slice(50), "terminal");
      reply(res, [], "ignored-after-empty");
    },
    async (base) => {
      assert.deepEqual(await api.messages(base, "ses_s6", { timeoutMs: 1000 }), entries);
      assert.equal(calls.length, 3);
      assert.equal(calls[1], "/api/session/ses_s6/message?cursor=opaque%2B%2F%3D%26");
    },
  );
});

test("v2 completion finds admitted user beyond page 50 without mixing older turns", async () => {
  const newest = [
    { id: "msg_later_idle", type: "idle", outcome: "failed" },
    { id: "msg_later_user", type: "user" },
    { id: "msg_idle", type: "idle", outcome: "succeeded" },
    { id: "msg_final", type: "assistant", time: { completed: 1 }, content: [] },
    ...Array.from({ length: 46 }, (_, index) => ({ id: `msg_tool_${index}`, type: "assistant" })),
  ];
  let calls = 0;
  await withServer(
    (req, res) => {
      calls += 1;
      if (!req.url.includes("cursor=")) return reply(res, newest, "older");
      reply(res, [{ id: "msg_anchor", type: "user" }], "irrelevant-history");
    },
    async (base) => {
      const result = await api.waitForCompletion(base, "ses_s6", "msg_anchor", { timeoutMs: 1000 });
      assert.equal(result.id, "msg_final");
      assert.equal(calls, 2);
    },
  );
});

test("v2 pagination shares one deadline across delayed response bodies", async () => {
  let calls = 0;
  await withServer(
    (_req, res) => {
      calls += 1;
      res.setHeader("content-type", "application/json");
      res.write('{"data":');
      setTimeout(
        () => res.end(JSON.stringify([{ id: `msg_${calls}` }]) + ',"cursor":{"next":"later"}}'),
        90,
      );
    },
    async (base) => {
      const started = Date.now();
      await assert.rejects(
        api.messages(base, "ses_s6", { timeoutMs: 150 }),
        /timed out|within 150ms/,
      );
      assert.equal(calls, 2);
      assert.ok(Date.now() - started < 350);
    },
  );
});

for (const cursor of [42, "same"]) {
  test(`v2 history rejects invalid or repeated cursors (${cursor})`, async () => {
    let calls = 0;
    await withServer(
      (_req, res) => {
        calls += 1;
        reply(res, [{ id: `msg_${calls}` }], cursor);
      },
      async (base) => {
        await assert.rejects(api.messages(base, "ses_s6"), /invalid cursor|cursor repeated/);
        assert.equal(calls, cursor === 42 ? 1 : 2);
      },
    );
  });
}
