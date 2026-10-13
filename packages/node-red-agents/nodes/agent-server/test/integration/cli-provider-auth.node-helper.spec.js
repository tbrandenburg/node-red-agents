"use strict";

const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { createRequire } = require("node:module");
const helper = require("node-red-node-test-helper");
const server = require("../../agent-server");
const provider = require("../../../model-provider/model-provider");
const runtimeRequire = createRequire(require.resolve("node-red/package.json"));
const catchNode = runtimeRequire("@node-red/nodes/core/common/25-catch.js");
const fixture = path.join(__dirname, "../../fixtures/fake-opencode.js");
const digest = (key) => createHash("sha256").update(key).digest("hex");

before(() => helper.startServer());
after(() => helper.stopServer());
afterEach(() => helper.unload());

async function load(options = {}) {
  await helper.load(
    [server, provider, catchNode],
    [
      { id: "tab", type: "tab", label: "daemon auth" },
      { id: "p", type: "model-provider", provider: "openrouter", defaultModel: "anthropic/test" },
      {
        id: "s",
        z: "tab",
        x: 100,
        y: 100,
        type: "agent-server",
        apiVersionMode: "v1",
        opencodeBinary: fixture,
        authMode: "provider",
        modelProvider: "p",
        startupTimeoutMs: 3000,
        requestTimeoutMs: 3000,
        wires: [["out"], ["events"]],
        ...options,
      },
      { id: "out", type: "helper", z: "tab", x: 200, y: 100 },
      { id: "events", type: "helper", z: "tab", x: 200, y: 200 },
      { id: "catcher", type: "catch", z: "tab", x: 100, y: 300, scope: ["s"], wires: [["caught"]] },
      { id: "caught", type: "helper", z: "tab", x: 200, y: 300 },
    ],
    { p: { apiKey: "synthetic-daemon-first" } },
  );
}

function send(msg) {
  return new Promise((resolve, reject) => {
    const node = helper.getNode("s");
    const out = helper.getNode("out");
    const timer = setTimeout(() => finish(new Error("daemon auth timeout")), 6000);
    const output = (value) => finish(undefined, value);
    const error = (call) => finish(new Error(String(call.args[0])));
    function finish(failure, value) {
      clearTimeout(timer);
      out.off("input", output);
      node.off("call:error", error);
      if (failure) reject(failure);
      else resolve(value);
    }
    out.on("input", output);
    node.on("call:error", error);
    node.receive(msg);
  });
}

test("daemon keeps launch credential until termination; restart uses rotation and close kills owned child", async () => {
  await load();
  const before = JSON.stringify({ ...process.env });
  const events = [];
  helper.getNode("events").on("input", (msg) => events.push(msg));
  const first = await send({ payload: "auth-test" });
  const child = helper.getNode("s").registry.get(first.sessionID).child;
  assert.equal(JSON.parse(first.payload).digest, digest("synthetic-daemon-first"));
  assert.deepEqual(JSON.parse(first.payload).model, {
    providerID: "openrouter",
    modelID: "anthropic/test",
  });
  helper.getNode("p").credentials.apiKey = "synthetic-daemon-second";
  const reused = await send({ payload: "auth-test", sessionID: first.sessionID });
  assert.equal(JSON.parse(reused.payload).digest, digest("synthetic-daemon-first"));
  await send({ operation: "terminate", sessionID: first.sessionID });
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  const restarted = await send({ payload: "auth-test" });
  assert.equal(JSON.parse(restarted.payload).digest, digest("synthetic-daemon-second"));
  const replacement = helper.getNode("s").registry.get(restarted.sessionID).child;
  const serialized = JSON.stringify({ first, reused, restarted, events });
  assert.ok(
    !serialized.includes("synthetic-daemon-first") &&
      !serialized.includes("synthetic-daemon-second"),
  );
  assert.ok(JSON.stringify({ ...process.env }) === before);
  await helper.unload();
  assert.ok(replacement.exitCode !== null || replacement.signalCode !== null);
});

test("invalid provider/model combination fails before daemon launch", async () => {
  await load({ model: "github-copilot/test" });
  await assert.rejects(send({ payload: "auth-test" }), /must match/);
  assert.equal(helper.getNode("s").registry.size(), 0);
});

test("old no-config flow still starts and returns a normal reply", async () => {
  await load({ authMode: undefined, modelProvider: "" });
  const reply = await send({ payload: "hello" });
  assert.equal(reply.payload, "hello from fake session");
});

test("environment mode ignores missing provider config and passes the ambient key to its daemon", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "synthetic-ambient-daemon";
  try {
    await load({
      authMode: "environment",
      modelProvider: "missing",
      model: "openrouter/anthropic/test",
    });
    const reply = await send({ payload: "auth-test" });
    assert.equal(JSON.parse(reply.payload).digest, digest("synthetic-ambient-daemon"));
    assert.ok(!reply.payload.includes("synthetic-ambient-daemon"));
    assert.ok(process.env.OPENROUTER_API_KEY === "synthetic-ambient-daemon");
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("HTTP error echoes and unhealthy daemon stderr are sanitized; failed startup is cleaned up", async () => {
  await load();
  await assert.rejects(
    send({ payload: "auth-error" }),
    (error) =>
      !error.message.includes("synthetic-daemon-first") && error.message.includes("[REDACTED]"),
  );
  await helper.unload();
  const previous = process.env.FAKE_OPENCODE_AUTH_FAILURE;
  process.env.FAKE_OPENCODE_AUTH_FAILURE = "1";
  try {
    await load({ startupTimeoutMs: 500 });
    await assert.rejects(
      send({ payload: "hello" }),
      (error) =>
        !error.message.includes("synthetic-daemon-first") &&
        error.message.includes("stderr: [REDACTED]"),
    );
    assert.equal(helper.getNode("s").registry.size(), 0);
  } finally {
    if (previous === undefined) delete process.env.FAKE_OPENCODE_AUTH_FAILURE;
    else process.env.FAKE_OPENCODE_AUTH_FAILURE = previous;
  }
});

for (const version of ["v1", "v2"]) {
  for (const prompt of ["envelope-error", "envelope-error-partial"]) {
    test(`${version} HTTP 200 APIError (${prompt}) reaches Catch without final success and leaves session reusable`, async () => {
      await load({ apiVersionMode: version });
      const node = helper.getNode("s");
      const outputs = [];
      const events = [];
      const errors = [];
      const caught = [];
      helper.getNode("caught").on("input", (msg) => caught.push(msg));
      helper.getNode("out").on("input", (msg) => outputs.push(msg));
      helper.getNode("events").on("input", (msg) => events.push(msg));
      node.on("call:error", (call) => errors.push(call.args[0]));

      await assert.rejects(send({ payload: prompt }), /APIError: provider authentication failed/);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(outputs.length, 0);
      assert.equal(errors.length, 1);
      assert.equal(caught.length, 1);
      assert.match(caught[0].error.message, /APIError: provider authentication failed/);
      assert.deepEqual(
        events.map((msg) => msg.payload.type),
        ["spawned", "running", "failed"],
      );
      assert.equal(events.at(-1).active, 0);
      const sessionID = node.registry.list()[0];
      assert.equal(node.registry.get(sessionID).busy, false);
      assert.ok(!JSON.stringify({ errors, events, caught }).includes("synthetic-private"));
      assert.equal(errors[0].cause, undefined);

      const reused = await send({ payload: "hello", sessionID });
      assert.equal(reused.payload, "hello from fake session");
      assert.equal(node.registry.size(), 1);
      assert.equal(node.registry.get(sessionID).busy, false);
    });
  }
}
