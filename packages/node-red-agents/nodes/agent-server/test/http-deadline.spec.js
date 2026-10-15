"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { request } = require("../lib/http");

for (const mode of ["headers", "stalled-body", "delayed-body"]) {
  test(`HTTP deadline includes ${mode} and cannot return late success`, async () => {
    let accepted = false;
    let delayed;
    const server = http.createServer((req, res) => {
      if (req.url === "/ready") {
        res.end("{}");
        return;
      }
      accepted = true;
      if (mode === "headers") return;
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"data":');
      if (mode === "delayed-body") delayed = setTimeout(() => res.end('"late"}'), 2000);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      await request(`${base}/ready`, { timeoutMs: 3000 });
      const started = Date.now();
      await assert.rejects(request(base, { timeoutMs: 500 }), /timed out after 500ms/);
      assert.equal(accepted, true);
      assert.ok(Date.now() - started < 1500);
    } finally {
      clearTimeout(delayed);
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });
}

test("redacted HTTP errors preserve status but discard arbitrary response diagnostics", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500).end('{"message":"synthetic-private-secret"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await assert.rejects(
      request(`http://127.0.0.1:${server.address().port}`, { redactErrors: true }),
      (error) =>
        error.status === 500 &&
        !error.message.includes("synthetic-private-secret") &&
        error.body === undefined &&
        error.cause === undefined,
    );
    assert.ok(server.listening);
  } finally {
    server.close();
    await once(server, "close");
  }
});
