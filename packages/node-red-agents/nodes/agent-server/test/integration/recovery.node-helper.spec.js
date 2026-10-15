"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const helper = require("node-red-node-test-helper");
const agentServer = require("../../agent-server");

before(() => helper.startServer());
after(() => helper.stopServer());
afterEach(() => helper.unload());

async function load() {
  await helper.load(agentServer, [
    { id: "tab", type: "tab", label: "uncertain execution recovery" },
    {
      id: "server",
      type: "agent-server",
      z: "tab",
      apiVersionMode: "v2",
      opencodeBinary: path.join(__dirname, "../../fixtures/fake-opencode.js"),
      requestTimeoutMs: 300,
      wires: [[], ["events"]],
    },
    { id: "events", type: "helper", z: "tab" },
  ]);
  return helper.getNode("server");
}

function input(node, msg) {
  msg = { ...msg, _msgid: randomUUID() };
  const outputs = [];
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      node.off("call:send", onSend);
      node.off("call:error", onError);
    };
    const finish = (error) => {
      cleanup();
      resolve({ outputs, error });
    };
    const onSend = (call) => {
      const output = call.args[0];
      if (output?.[0]?._msgid !== msg._msgid) return;
      outputs.push(output);
      finish();
    };
    const onError = (call) => {
      if (call.args[1]?._msgid === msg._msgid) finish(call.args[0]);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("recovery test input timed out"));
    }, 6000);
    node.on("call:send", onSend);
    node.on("call:error", onError);
    node.receive(msg);
  });
}

function watch(node) {
  const events = [];
  let sessionID;
  const recovering = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("interrupt handler was not reached")), 4000);
    helper.getNode("events").on("input", (msg) => {
      events.push(msg.payload.type);
      if (msg.payload.type !== "running") return;
      sessionID = msg.sessionID;
      const child = node.registry.get(sessionID).child;
      const listener = (chunk) => {
        if (!chunk.toString().includes("blocked interrupt")) return;
        clearTimeout(timer);
        child.stdout.off("data", listener);
        resolve();
      };
      child.stdout.on("data", listener);
    });
  });
  return { events, recovering, session: () => sessionID };
}

for (const prompt of [
  "s4-lost-admission",
  "s4-poll-timeout",
  "s4-stalled-admission",
  "s4-delayed-admission",
]) {
  test(`${prompt}: busy until correlated interrupted idle, failure never becomes late success`, async () => {
    const node = await load();
    const observed = watch(node);
    const pending = input(node, { payload: prompt });
    await observed.recovering;
    const sessionID = observed.session();
    assert.equal(node.registry.get(sessionID).busy, true);
    const concurrent = await input(node, { payload: "hello", sessionID });
    assert.match(concurrent.error.message, /processing a message/);
    assert.deepEqual(concurrent.outputs, []);
    const failure = await pending;
    assert.match(failure.error.message, /failed|timed out|did not complete/);
    assert.equal(failure.error.message.includes("synthetic-private"), false);
    assert.deepEqual(failure.outputs, []);
    assert.equal(node.registry.get(sessionID).busy, false);
    const history = await input(node, { operation: "history", sessionID });
    assert.equal(history.outputs[0][0].payload[0].outcome, "interrupted");
    assert.match(history.outputs[0][0].payload[1].id, /^msg_[0-9a-f-]{36}$/);
    const next = await input(node, { payload: "hello", sessionID });
    assert.equal(next.error, undefined);
    assert.equal(next.outputs[0][0].payload, "hello from fake session");
    // Let the Node-RED wire deliver queued lifecycle messages.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(observed.events, ["spawned", "running", "failed", "running", "completed"]);
  });
}

for (const prompt of [
  "block-prompt",
  "s4-interrupt-failure",
  "s4-unconfirmed-idle",
  "s4-interrupt-stalled-body",
]) {
  test(`${prompt}: removes and kills only the owned daemon, a new daemon can run`, async () => {
    const node = await load();
    const first = await input(node, { payload: "hello" });
    const sessionID = first.outputs[0][0].sessionID;
    const child = node.registry.get(sessionID).child;
    const other = await input(node, { payload: "hello" });
    const otherID = other.outputs[0][0].sessionID;
    const otherChild = node.registry.get(otherID).child;
    const started = Date.now();
    const failure = await input(node, { payload: prompt, sessionID });
    assert.ok(Date.now() - started < 2000);
    assert.ok(failure.error);
    assert.equal(failure.error.message.includes("synthetic-private"), false);
    assert.deepEqual(failure.outputs, []);
    assert.equal(node.registry.has(sessionID), false);
    assert.notEqual(child.exitCode ?? child.signalCode, null);
    assert.equal(node.registry.has(otherID), true);
    assert.equal(otherChild.exitCode ?? otherChild.signalCode, null);
    const stale = await input(node, { payload: "hello", sessionID });
    assert.match(stale.error.message, /unknown sessionID/);
    assert.deepEqual(stale.outputs, []);
    const next = await input(node, { payload: "hello" });
    assert.equal(next.error, undefined);
    assert.notEqual(next.outputs[0][0].sessionID, sessionID);
    assert.equal(next.outputs[0][0].payload, "hello from fake session");
  });
}

test("lost admission response after success still fails exactly once and permits settled reuse", async () => {
  const node = await load();
  const first = await input(node, { payload: "hello" });
  const sessionID = first.outputs[0][0].sessionID;
  const failure = await input(node, { payload: "s4-lost-completed", sessionID });
  assert.match(failure.error.message, /request.*failed/);
  assert.deepEqual(failure.outputs, []);
  assert.equal(node.registry.get(sessionID).busy, false);
  const history = await input(node, { operation: "history", sessionID });
  assert.equal(history.outputs[0][0].payload[0].outcome, "succeeded");
  const next = await input(node, { payload: "hello", sessionID });
  assert.equal(next.error, undefined);
  assert.equal(next.outputs[0][0].payload, "hello from fake session");
});
