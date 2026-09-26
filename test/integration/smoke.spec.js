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
const OPENCODE_MODE = process.env.NODE_RED_AGENTS_OPENCODE_MODE || "v1";
let instance;

function withOpenCodeMode(flow) {
  assert.ok(["v1", "v2"].includes(OPENCODE_MODE), "NODE_RED_AGENTS_OPENCODE_MODE must be v1 or v2");
  return flow.map((node) => {
    if (node.type === "agent") return { ...node, openCodeVersionMode: OPENCODE_MODE };
    if (node.type === "agent-server") return { ...node, apiVersionMode: OPENCODE_MODE };
    return node;
  });
}

before(async () => {
  instance = await startSmokeInstance();
});

after(async () => {
  if (instance) await instance.stop();
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
  const flow = withOpenCodeMode(require(path.join(FLOWS_DIR, "agent-smoke.json")));
  await instance.deployFlow(flow);
  const result = await waitForDebug({
    baseUrl: instance.baseUrl,
    injectId: "smoke-agent-inject",
    debugId: "smoke-agent-debug",
    maxWaitMs: 60000,
  });
  assert.equal(result.ok, true, `expected a debug message, got: ${JSON.stringify(result)}`);

  // Assert the model actually followed the prompt's instruction, not just
  // that *some* output arrived.
  const msg = JSON.parse(result.data.msg);
  assert.match(
    String(msg.payload).toLowerCase(),
    /\bpong\b/,
    `expected the reply to contain "pong", got: ${JSON.stringify(msg.payload)}`,
  );
});

test(
  "OpenCode v2 invokes a real local MCP tool with tool permissions configured",
  { skip: OPENCODE_MODE !== "v2" },
  async () => {
    const fixture = path.join(__dirname, "fixtures", "mcp-echo.js");
    const flow = withOpenCodeMode(require(path.join(FLOWS_DIR, "agent-smoke.json"))).map((node) =>
      node.type === "agent"
        ? {
            ...node,
            prompt:
              "Call the available echo_marker MCP tool, then reply with exactly the text it returns.",
            promptType: "str",
            mcpServers: [
              { name: "smoke", type: "local", command: process.execPath, args: [fixture] },
            ],
            allowedTools: ["*"],
            deniedTools: ["shell"],
          }
        : node,
    );
    await instance.deployFlow(flow);
    const result = await waitForDebug({
      baseUrl: instance.baseUrl,
      injectId: "smoke-agent-inject",
      debugId: "smoke-agent-debug",
      errorDebugId: "smoke-agent-error-debug",
      maxWaitMs: 60000,
    });
    assert.equal(result.ok, true, `expected a debug message, got: ${JSON.stringify(result)}`);
    const msg = JSON.parse(result.data.msg);
    assert.match(
      String(msg.payload),
      /MCP_TOOL_VERIFIED_6d28a6/,
      `expected the MCP marker, got payload=${JSON.stringify(msg.payload)} execution=${JSON.stringify(msg.agentExecution)}`,
    );
  },
);

test("agent resume smoke flow: two chained agent (opencode) nodes -- second resumes the first's real session", async () => {
  const flow = withOpenCodeMode(require(path.join(FLOWS_DIR, "agent-resume-smoke.json")));
  await instance.deployFlow(flow);
  const result = await waitForDebug({
    baseUrl: instance.baseUrl,
    injectId: "smoke-agent-resume-inject",
    debugId: "smoke-agent-resume-debug",
    maxWaitMs: 90000, // two real sequential opencode calls -- give it real headroom
  });
  assert.equal(result.ok, true, `expected a debug message, got: ${JSON.stringify(result)}`);
  const msg = JSON.parse(result.data.msg);
  assert.equal(
    msg.agentExecution.resumed,
    true,
    `expected the second agent node to report resumed:true, got: ${JSON.stringify(msg.agentExecution)}`,
  );
  assert.match(
    String(msg.payload).toLowerCase(),
    /\bsecond\b/,
    `expected the second agent's reply to contain "second", got: ${JSON.stringify(msg.payload)}`,
  );
});

test("agent-server smoke flow: v1/v2 message, history, and terminate lifecycle", async () => {
  const flow = withOpenCodeMode(require(path.join(FLOWS_DIR, "agent-server-smoke.json")));
  await instance.deployFlow(flow);
  const result = await waitForDebug({
    baseUrl: instance.baseUrl,
    injectId: "smoke-agent-server-inject",
    debugId: "smoke-agent-server-debug",
    errorDebugId: "smoke-agent-server-error-debug",
    maxWaitMs: 60000,
  });
  assert.equal(
    result.ok,
    true,
    `expected a debug message, got: ${JSON.stringify(result)}\n--- node-red stderr ---\n${instance.getStderrTail()}`,
  );
  const msg = JSON.parse(result.data.msg);
  assert.equal(msg.payload, true, "expected the server daemon to terminate successfully");
  assert.equal(msg.abortAcknowledged, true, "expected the server abort operation to complete");
  assert.match(
    String(msg.assistantOutput).toLowerCase(),
    /\bpong\b/,
    `expected the assistant output to contain "pong", got: ${JSON.stringify(msg.assistantOutput)}`,
  );
  assert.ok(Array.isArray(msg.history), "expected v1/v2 session history to be returned");
});
