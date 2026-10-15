"use strict";

const path = require("node:path");
const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const helper = require("node-red-node-test-helper");
const agentServer = require("../../agent-server");

before(() => helper.startServer());
after(() => helper.stopServer());
afterEach(() => helper.unload());

async function load() {
  await helper.load(agentServer, [
    { id: "tab", type: "tab", label: "turn completion" },
    {
      id: "server",
      type: "agent-server",
      z: "tab",
      apiVersionMode: "v2",
      opencodeBinary: path.join(__dirname, "../../fixtures/fake-opencode.js"),
      requestTimeoutMs: 2000,
      wires: [["result"], ["events"]],
    },
    { id: "result", type: "helper", z: "tab" },
    { id: "events", type: "helper", z: "tab" },
  ]);
  return helper.getNode("server");
}

function input(node, msg) {
  const outputs = [];
  return new Promise((resolve, reject) => {
    let error;
    const result = helper.getNode("result");
    const events = helper.getNode("events");
    const onResult = (output) => outputs.push([output, null]);
    const onError = (call) => {
      error = call.args[0];
    };
    const cleanup = () => {
      clearTimeout(timer);
      result.off("input", onResult);
      events.off("input", onEvent);
      node.off("call:error", onError);
    };
    const onEvent = (output) => {
      if (["completed", "failed"].includes(output.payload.type)) {
        setImmediate(() => {
          cleanup();
          resolve({ outputs, error });
        });
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(error || new Error("turn completion timed out"));
    }, 5000);
    result.on("input", onResult);
    events.on("input", onEvent);
    node.on("call:error", onError);
    node.receive(msg);
  });
}

test("v2 node waits for final idle across tool steps and ignores the reused session's stale idle", async () => {
  const node = await load();
  const first = await input(node, { payload: "hello" });
  assert.equal(first.error, undefined);
  const sessionID = first.outputs[0][0].sessionID;
  assert.equal(first.outputs[0][0].payload, "hello from fake session");
  const events = [];
  helper.getNode("events").on("input", (msg) => events.push(msg.payload.type));
  const result = await input(node, { payload: "s3-multi-step", sessionID });
  assert.equal(result.error, undefined);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0][0].payload, "final multi-step answer");
  assert.deepEqual(events.filter(Boolean), ["running", "completed"]);
  assert.equal(node.registry.get(sessionID).busy, false);
});

for (const prompt of ["s3-interrupted", "envelope-error-with-text"]) {
  test(`v2 node emits failed, never a result/completed for ${prompt}`, async () => {
    const node = await load();
    const events = [];
    helper.getNode("events").on("input", (msg) => events.push(msg.payload.type));
    const result = await input(node, { payload: prompt });
    assert.match(result.error.message, /message aborted|provider authentication failed/);
    assert.deepEqual(result.outputs, []);
    assert.deepEqual(events.filter(Boolean), ["spawned", "running", "failed"]);
    assert.equal(node.registry.summary().busy, 0);
    const sessionID = node.registry.summary().sessions[0].sessionID;
    const next = await input(node, { payload: "hello", sessionID });
    assert.equal(next.error, undefined);
    assert.equal(next.outputs[0][0].payload, "hello from fake session");
  });
}
