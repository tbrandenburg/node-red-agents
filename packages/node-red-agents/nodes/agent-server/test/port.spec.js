"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { findFreePort } = require("../lib/port");

test("findFreePort resolves a port number that is actually free to bind", async () => {
  const port = await findFreePort();
  assert.equal(typeof port, "number");
  assert.ok(port > 0 && port < 65536);

  // Prove it's actually free: bind it ourselves right after.
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close(resolve);
    });
  });
});

test("findFreePort returns different ports across concurrent calls", async () => {
  const ports = await Promise.all([findFreePort(), findFreePort(), findFreePort()]);
  assert.equal(new Set(ports).size, ports.length, "each call should get its own free port");
});
