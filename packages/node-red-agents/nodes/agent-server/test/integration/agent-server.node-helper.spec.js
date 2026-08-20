"use strict";

// Node-level integration test: loads agent-server.js into a real Node-RED
// runtime (via node-red-node-test-helper) and exercises a minimal
// inject -> agent-server (operation "status") -> helper("output") flow.
// Unlike agent-server's existing unit specs (test/*.spec.js), which call
// lib/ functions directly, this goes through the real
// RED.nodes.createNode/registerType wiring and node.on('input', ...)
// handler exactly as Node-RED itself would invoke it.
//
// Uses the "status" operation with no sessionID (aggregate summary, purely
// local -- see agent-server.js's handleStatusOperation) so this test needs
// no spawned daemon and no fake `opencode` binary at all: it's proving the
// node's real wiring, not re-testing lib/registry.js's logic (already
// unit-tested in test/registry.spec.js and test/status.spec.js).
const path = require("node:path");
const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const helper = require("node-red-node-test-helper");
const agentServerNode = require("../../agent-server.js");

const FIXTURE = path.join(__dirname, "..", "..", "fixtures", "fake-opencode.js");

before(() => helper.startServer());
after(() => helper.stopServer());
afterEach(() => helper.unload());

test("a minimal inject -> agent-server(status) -> output flow returns a real registry summary with no daemons tracked", async () => {
  const flow = [
    { id: "n1", type: "agent-server", name: "agent-server", operation: "status", wires: [["n2"]] },
    { id: "n2", type: "helper" },
  ];
  await helper.load(agentServerNode, flow);
  const n1 = helper.getNode("n1");
  const n2 = helper.getNode("n2");

  const received = await new Promise((resolve, reject) => {
    n2.on("input", resolve);
    n1.receive({ payload: "go" });
    setTimeout(
      () => reject(new Error("timed out waiting for agent-server node output")),
      5000,
    ).unref();
  });

  assert.deepEqual(received.payload, { total: 0, busy: 0, idle: 0, sessions: [] });
  assert.equal(received.serverId, n1.id, "status reply is stamped with this node instance's id");
  assert.equal(
    received.serverName,
    "agent-server",
    "status reply is stamped with the configured Name",
  );
});

test("msg.serverName overrides the configured Name (serverName/serverNameType set to msg)", async () => {
  const flow = [
    {
      id: "n1",
      type: "agent-server",
      name: "static-name",
      operation: "status",
      serverName: "serverName",
      serverNameType: "msg",
      wires: [["n2"]],
    },
    { id: "n2", type: "helper" },
  ];
  await helper.load(agentServerNode, flow);
  const n1 = helper.getNode("n1");
  const n2 = helper.getNode("n2");

  const received = await new Promise((resolve, reject) => {
    n2.on("input", resolve);
    n1.receive({ payload: "go", serverName: "dynamic-name" });
    setTimeout(
      () => reject(new Error("timed out waiting for agent-server node output")),
      5000,
    ).unref();
  });

  assert.equal(
    received.serverName,
    "dynamic-name",
    "msg.serverName wins over the configured Name",
  );
});

test("serverName/serverNameType set to msg falls back to the configured Name when msg.serverName is absent", async () => {
  const flow = [
    {
      id: "n1",
      type: "agent-server",
      name: "static-name",
      operation: "status",
      serverName: "serverName",
      serverNameType: "msg",
      wires: [["n2"]],
    },
    { id: "n2", type: "helper" },
  ];
  await helper.load(agentServerNode, flow);
  const n1 = helper.getNode("n1");
  const n2 = helper.getNode("n2");

  const received = await new Promise((resolve, reject) => {
    n2.on("input", resolve);
    n1.receive({ payload: "go" });
    setTimeout(
      () => reject(new Error("timed out waiting for agent-server node output")),
      5000,
    ).unref();
  });

  assert.equal(
    received.serverName,
    "static-name",
    "blank/unresolved typed-input falls back to the node's Name",
  );
});

// msg.maxInstances end-to-end tests below spawn real (fake) daemon
// processes via FIXTURE (see fixtures/fake-opencode.js), which now also
// serves POST /session and POST /session/:id/message -- enough for
// spawnNewInstance()'s full flow (health check + session creation +
// message send) to succeed without the real opencode binary.
function send(node, msg) {
  return new Promise((resolve, reject) => {
    const onInput = (received) => {
      helperOutput.off("input", onInput);
      resolve(received);
    };
    const helperOutput = helper.getNode("n2");
    helperOutput.on("input", onInput);
    node.receive(msg);
    setTimeout(
      () => reject(new Error("timed out waiting for agent-server node output")),
      5000,
    ).unref();
  });
}

test("msg.maxInstances raises the deploy-time Max instances cap at runtime, unblocking a spawn that would otherwise be rejected", async () => {
  const flow = [
    {
      id: "n1",
      type: "agent-server",
      name: "agent-server",
      operation: "message",
      opencodeBinary: FIXTURE,
      maxInstances: 1,
      promptProp: "payload",
      promptPropType: "msg",
      wires: [["n2"]],
    },
    { id: "n2", type: "helper" },
  ];
  await helper.load(agentServerNode, flow);
  const n1 = helper.getNode("n1");

  assert.equal(n1.maxInstances, 1, "deploy-time default before any override");

  const first = await send(n1, { payload: "hello" });
  assert.equal(first.payload, "hello from fake session");
  assert.equal(first.serverId, n1.id, "message reply is stamped with this node instance's id");
  assert.equal(
    first.serverName,
    "agent-server",
    "message reply is stamped with the configured Name",
  );
  assert.equal(n1.registry.size(), 1);

  // At the cap (1/1) -- a second no-sessionID trigger without raising the
  // cap would be rejected by spawnNewInstance's guard clause. done(err) in
  // the input handler surfaces as node.error(err, msg) at the runtime level
  // (see @node-red/runtime's Node.prototype._complete) -- proxied by the
  // test helper as a sinon spy call on 'call:error', whose args are [err, msg].
  const rejectedCall = await new Promise((resolve) => {
    n1.once("call:error", resolve);
    n1.receive({ payload: "hello again" });
  });
  assert.match(rejectedCall.args[0].message, /max instances \(1\) reached/);

  // Now raise the cap via msg.maxInstances and confirm the next spawn
  // succeeds and the live node.maxInstances reflects the override.
  const second = await send(n1, { payload: "hello once more", maxInstances: 2 });
  assert.equal(n1.maxInstances, 2);
  assert.equal(second.payload, "hello from fake session");
  assert.equal(n1.registry.size(), 2);
});

test("msg.maxInstances lowering the cap never evicts already-spawned daemons, only blocks future spawns", async () => {
  const flow = [
    {
      id: "n1",
      type: "agent-server",
      name: "agent-server",
      operation: "message",
      opencodeBinary: FIXTURE,
      maxInstances: 2,
      promptProp: "payload",
      promptPropType: "msg",
      wires: [["n2"]],
    },
    { id: "n2", type: "helper" },
  ];
  await helper.load(agentServerNode, flow);
  const n1 = helper.getNode("n1");

  await send(n1, { payload: "hello" });
  await send(n1, { payload: "hello again" });
  assert.equal(n1.registry.size(), 2);

  // Lower the cap below the current tracked count.
  const rejectedCall = await new Promise((resolve) => {
    n1.once("call:error", resolve);
    n1.receive({ payload: "one more please", maxInstances: 1 });
  });
  assert.equal(n1.maxInstances, 1);
  assert.match(rejectedCall.args[0].message, /max instances \(1\) reached/);
  assert.equal(
    n1.registry.size(),
    2,
    "lowering the cap must not evict the two already-spawned daemons",
  );
});

test("msg.maxInstances with an invalid value (negative/non-numeric) is ignored, leaving the cap unchanged", async () => {
  const flow = [
    {
      id: "n1",
      type: "agent-server",
      operation: "status",
      maxInstances: 3,
      wires: [["n2"]],
    },
    { id: "n2", type: "helper" },
  ];
  await helper.load(agentServerNode, flow);
  const n1 = helper.getNode("n1");

  const first = await send(n1, { payload: "go", maxInstances: -5 });
  assert.equal(n1.maxInstances, 3, "negative override must be ignored");
  assert.equal(
    first.serverName,
    undefined,
    "no fallback -- an unnamed node's serverName stays undefined",
  );

  await send(n1, { payload: "go", maxInstances: "not-a-number" });
  assert.equal(n1.maxInstances, 3, "non-numeric override must be ignored");

  await send(n1, { payload: "go", maxInstances: 0 });
  assert.equal(n1.maxInstances, 0, "0 is a valid override and keeps meaning unlimited");
});
