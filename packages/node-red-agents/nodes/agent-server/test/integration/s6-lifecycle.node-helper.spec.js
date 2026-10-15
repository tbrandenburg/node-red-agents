"use strict";

const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const helper = require("node-red-node-test-helper");
const server = require("../../agent-server");
const fixture = path.join(__dirname, "../../fixtures/fake-opencode.js");

before(() => helper.startServer());
after(() => helper.stopServer());
afterEach(() => helper.unload());

function waitFor(emitter, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, listener);
      reject(new Error(`timed out waiting for ${event}`));
    }, 6000);
    function listener(value) {
      if (!predicate(value)) return;
      clearTimeout(timer);
      emitter.off(event, listener);
      resolve(value);
    }
    emitter.on(event, listener);
  });
}

async function load(config = {}) {
  await helper.load(server, [
    { id: "tab", type: "tab" },
    {
      id: "s",
      type: "agent-server",
      z: "tab",
      apiVersionMode: "v2",
      opencodeBinary: fixture,
      startupTimeoutMs: 1500,
      requestTimeoutMs: 2000,
      wires: [["out"], ["events"]],
      ...config,
    },
    { id: "out", type: "helper", z: "tab" },
    { id: "events", type: "helper", z: "tab" },
  ]);
  return helper.getNode("s");
}

test("simultaneous inputs reserve startup slots before asynchronous port allocation", async () => {
  const node = await load({ maxInstances: 1 });
  const errors = [];
  node.on("call:error", (call) => errors.push(call.args[0].message));
  const output = waitFor(helper.getNode("out"), "input");
  const rejected = waitFor(node, "call:error", () => errors.length === 2);
  node.receive({ payload: "one" });
  node.receive({ payload: "two" });
  node.receive({ payload: "three" });
  await Promise.all([output, rejected]);
  assert.equal(node.registry.size(), 1);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => error.includes("max instances (1) reached")));
});

test("spawn failure reaches Node-RED error handling and releases the reserved slot", async () => {
  const node = await load({ opencodeBinary: "/nonexistent/s6-opencode", maxInstances: 1 });
  const failure = waitFor(node, "call:error");
  node.receive({ payload: "one" });
  assert.match((await failure).args[0].message, /daemon failed to spawn/);
  assert.equal(node.registry.size(), 0);
  node.opencodeBinary = fixture;
  const output = waitFor(helper.getNode("out"), "input");
  node.receive({ payload: "retry" });
  assert.equal((await output).payload, "hello from fake session");
  assert.equal(node.registry.size(), 1);
});

test("failed automatic detection is retried rather than permanently cached as v1", async () => {
  const previous = process.env.FAKE_OPENCODE_VERSION;
  process.env.FAKE_OPENCODE_VERSION = "2.0.28";
  try {
    const node = await load({ apiVersionMode: "auto", opencodeBinary: "/nonexistent/s6-opencode" });
    const failure = waitFor(node, "call:error");
    node.receive({ payload: "one" });
    await failure;
    node.opencodeBinary = fixture;
    const output = waitFor(helper.getNode("out"), "input");
    node.receive({ payload: "retry" });
    const message = await output;
    assert.equal(node.registry.get(message.sessionID).apiVersion, "v2");
    assert.equal(message.payload, "hello from fake session");
  } finally {
    if (previous === undefined) delete process.env.FAKE_OPENCODE_VERSION;
    else process.env.FAKE_OPENCODE_VERSION = previous;
  }
});

test("unexpected idle daemon exit emits exactly one safe failed event and retires the session", async () => {
  const node = await load();
  const output = waitFor(helper.getNode("out"), "input");
  node.receive({ payload: "one" });
  const message = await output;
  const record = node.registry.get(message.sessionID);
  const events = [];
  helper.getNode("events").on("input", (event) => events.push(event));
  const failed = waitFor(
    helper.getNode("events"),
    "input",
    (event) => event.payload.type === "failed",
  );
  const error = waitFor(node, "call:error");
  process.kill(record.child.pid, "SIGKILL");
  const [event, call] = await Promise.all([failed, error]);
  assert.equal(event.sessionID, message.sessionID);
  assert.equal(call.args[0], "agent-server: owned daemon exited unexpectedly");
  assert.equal(node.registry.size(), 0);
  assert.equal(events.filter((entry) => entry.payload.type === "failed").length, 1);
});

test("v2 canonical password overrides inherited password and pagination reaches an anchor beyond 50", async () => {
  const inherited = process.env.OPENCODE_PASSWORD;
  const check = process.env.FAKE_OPENCODE_CHECK_AUTH;
  process.env.OPENCODE_PASSWORD = "synthetic-inherited-password";
  process.env.FAKE_OPENCODE_CHECK_AUTH = "1";
  try {
    const node = await load({ authPassword: "synthetic-node-password" });
    const output = waitFor(helper.getNode("out"), "input");
    node.receive({ payload: "s6-long-turn" });
    const message = await output;
    assert.equal(message.payload, "hello from fake session");
    const history = waitFor(helper.getNode("out"), "input");
    node.receive({ operation: "history", sessionID: message.sessionID });
    const reply = await history;
    assert.equal(reply.payload.length, 63);
    assert.equal(reply.payload.at(-1).type, "user");
    assert.equal(reply.payload[0].type, "idle");
  } finally {
    if (inherited === undefined) delete process.env.OPENCODE_PASSWORD;
    else process.env.OPENCODE_PASSWORD = inherited;
    if (check === undefined) delete process.env.FAKE_OPENCODE_CHECK_AUTH;
    else process.env.FAKE_OPENCODE_CHECK_AUTH = check;
  }
});
