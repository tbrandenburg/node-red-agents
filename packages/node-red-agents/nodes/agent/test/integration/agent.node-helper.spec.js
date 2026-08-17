"use strict";

// Node-level integration test: loads agent.js into a real Node-RED runtime
// (via node-red-node-test-helper) and exercises a minimal
// inject -> agent (opencode, prompt invocation, direct runtime) ->
// helper("output") flow. Unlike agent's existing unit specs (test/**/*.spec.js),
// which call lib/ functions directly, this goes through the real
// RED.nodes.createNode/registerType wiring and node.on('input', ...)
// handler exactly as Node-RED itself would invoke it.
//
// The spawned `opencode` binary is faked via PATH (see ../fixtures/opencode,
// a fixed single-JSONL-event stand-in) -- no real opencode CLI or network
// involved. lib/agents/opencode.js's own event-parsing logic is already
// covered against real recorded event shapes in
// lib/agents/opencode.spec.js; this test only proves the node wires that
// logic up correctly end to end.
const path = require("node:path");
const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const helper = require("node-red-node-test-helper");
const agentNode = require("../../agent.js");

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");
const originalPath = process.env.PATH;

before(() => {
  process.env.PATH = FIXTURES_DIR + path.delimiter + originalPath;
  return helper.startServer();
});

after(() => {
  process.env.PATH = originalPath;
  return helper.stopServer();
});

afterEach(() => helper.unload());

test("a minimal inject -> agent -> output flow runs the (faked) opencode CLI and produces a real Node-RED message", async () => {
  const flow = [
    {
      id: "n1",
      type: "agent",
      name: "agent",
      agent: "opencode",
      runtime: "direct",
      invocation: "prompt",
      prompt: "payload",
      promptType: "msg",
      wires: [["n2"], []],
    },
    { id: "n2", type: "helper" },
  ];
  await helper.load(agentNode, flow);
  const n1 = helper.getNode("n1");
  const n2 = helper.getNode("n2");

  const received = await new Promise((resolve, reject) => {
    n2.on("input", resolve);
    n1.receive({ payload: "say hello" });
    setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
  });

  assert.equal(received.payload, "hello from fake opencode");
  assert.equal(received.sessionID, "fake-session-id");
  assert.equal(received.agentExecution.status, "completed");
  assert.equal(received.agentExecution.exitCode, 0);
});
