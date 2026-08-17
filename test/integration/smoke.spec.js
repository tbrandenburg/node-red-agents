"use strict";

// Smoke/E2E suite: boots a real, throwaway Node-RED instance (never data/
// or demo/), deploys one minimal inject -> node -> debug flow per node
// (agent, agent-server, gh) via the real admin HTTP API, and asserts on
// the real debug output via the same subscribe/inject/wait logic AGENTS.md
// documents for round-tripping against a running instance
// (scripts/lib/watch-debug.js, shared with scripts/run-and-watch.js).
//
// Unlike the node-level integration specs (packages/node-red-agents/
// nodes/*/test/integration/), which fake the spawned CLI via PATH inside
// an in-process test-helper runtime, this suite runs the *actual*
// packaged node-red-agents module inside a *separate, real* node-red
// process, and (for agent/gh) shells out to the real opencode/gh CLIs on
// PATH -- see `make test-e2e` (never part of `make test`/CI's default
// gate, since it needs real, authenticated CLIs).
const path = require("node:path");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startSmokeInstance } = require("./lib/node-red-instance");
const { waitForDebug } = require("../../scripts/lib/watch-debug");

const FLOWS_DIR = path.join(__dirname, "flows");
let instance;

before(async () => {
  instance = await startSmokeInstance();
});

after(() => {
  if (instance) instance.stop();
});

test("gh smoke flow: inject -> gh (pr list) -> debug produces real output, no red status", async () => {
  const flow = require(path.join(FLOWS_DIR, "gh-smoke.json"));
  await instance.deployFlow(flow);
  const result = await waitForDebug({
    baseUrl: instance.baseUrl,
    injectId: "smoke-gh-inject",
    debugId: "smoke-gh-debug",
    maxWaitMs: 30000,
  });
  assert.equal(result.ok, true, `expected a debug message, got: ${JSON.stringify(result)}`);
});

test("agent smoke flow: inject -> agent (opencode) -> debug produces real output, no red status", async () => {
  const flow = require(path.join(FLOWS_DIR, "agent-smoke.json"));
  await instance.deployFlow(flow);
  const result = await waitForDebug({
    baseUrl: instance.baseUrl,
    injectId: "smoke-agent-inject",
    debugId: "smoke-agent-debug",
    maxWaitMs: 60000,
  });
  assert.equal(result.ok, true, `expected a debug message, got: ${JSON.stringify(result)}`);
});

test("agent-server smoke flow: inject -> agent-server (status) -> debug produces a real registry summary", async () => {
  const flow = require(path.join(FLOWS_DIR, "agent-server-smoke.json"));
  await instance.deployFlow(flow);
  const result = await waitForDebug({
    baseUrl: instance.baseUrl,
    injectId: "smoke-agent-server-inject",
    debugId: "smoke-agent-server-debug",
    maxWaitMs: 15000,
  });
  assert.equal(result.ok, true, `expected a debug message, got: ${JSON.stringify(result)}`);
  const msg = JSON.parse(result.data.msg);
  assert.deepEqual(msg.payload, { total: 0, busy: 0, idle: 0, sessions: [] });
});
