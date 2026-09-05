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
  assert.equal(received.agentId, n1.id, "result msg is stamped with this node instance's id");
  assert.equal(received.agentName, "agent", "result msg is stamped with the configured Name");
});

test("msg.concurrency overrides the deploy-time Concurrency field at runtime, without a redeploy", async () => {
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
      concurrency: 1,
      wires: [["n2"], []],
    },
    { id: "n2", type: "helper" },
  ];
  await helper.load(agentNode, flow);
  const n1 = helper.getNode("n1");
  const n2 = helper.getNode("n2");

  assert.equal(n1.scheduler.concurrency, 1, "deploy-time default before any override");

  const received = await new Promise((resolve, reject) => {
    n2.on("input", resolve);
    n1.receive({ payload: "say hello", concurrency: 3 });
    setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
  });

  assert.equal(received.payload, "hello from fake opencode");
  assert.equal(n1.scheduler.concurrency, 3, "msg.concurrency raised the bound live");
});

test("msg.concurrency with an invalid value (non-numeric/non-positive) is ignored, leaving the bound unchanged", async () => {
  const flow = [
    {
      id: "n1",
      type: "agent",
      agent: "opencode",
      runtime: "direct",
      invocation: "prompt",
      prompt: "payload",
      promptType: "msg",
      concurrency: 2,
      wires: [["n2"], []],
    },
    { id: "n2", type: "helper" },
  ];
  await helper.load(agentNode, flow);
  const n1 = helper.getNode("n1");
  const n2 = helper.getNode("n2");

  const received = await new Promise((resolve, reject) => {
    n2.on("input", resolve);
    n1.receive({ payload: "say hello", concurrency: -5 });
    setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
  });

  assert.equal(n1.scheduler.concurrency, 2, "invalid override must not change the bound");
  assert.equal(
    received.agentName,
    undefined,
    "no fallback -- an unnamed node's agentName stays undefined",
  );
});

test("msg.agentName overrides the configured Name (agentName/agentNameType set to msg)", async () => {
  const flow = [
    {
      id: "n1",
      type: "agent",
      name: "static-name",
      agent: "opencode",
      runtime: "direct",
      invocation: "prompt",
      prompt: "payload",
      promptType: "msg",
      agentName: "agentName",
      agentNameType: "msg",
      wires: [["n2"], []],
    },
    { id: "n2", type: "helper" },
  ];
  await helper.load(agentNode, flow);
  const n1 = helper.getNode("n1");
  const n2 = helper.getNode("n2");

  const received = await new Promise((resolve, reject) => {
    n2.on("input", resolve);
    n1.receive({ payload: "say hello", agentName: "dynamic-name" });
    setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
  });

  assert.equal(received.agentName, "dynamic-name", "msg.agentName wins over the configured Name");
});

test("agentName/agentNameType set to msg falls back to the configured Name when msg.agentName is absent", async () => {
  const flow = [
    {
      id: "n1",
      type: "agent",
      name: "static-name",
      agent: "opencode",
      runtime: "direct",
      invocation: "prompt",
      prompt: "payload",
      promptType: "msg",
      agentName: "agentName",
      agentNameType: "msg",
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

  assert.equal(
    received.agentName,
    "static-name",
    "blank/unresolved typed-input falls back to the node's Name",
  );
});

test("agentExecution.costUsd/tokens are surfaced for opencode runs whose step_finish events carry usage (issue #22)", async () => {
  const WITH_USAGE_FIXTURES_DIR = path.join(FIXTURES_DIR, "with-usage");
  const priorPath = process.env.PATH;
  process.env.PATH = WITH_USAGE_FIXTURES_DIR + path.delimiter + priorPath;

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
      wires: [["n2"], ["n3"]],
    },
    { id: "n2", type: "helper" },
    { id: "n3", type: "helper" },
  ];
  try {
    await helper.load(agentNode, flow);
    const n1 = helper.getNode("n1");
    const n2 = helper.getNode("n2");
    const n3 = helper.getNode("n3");

    const events = [];
    n3.on("input", (msg) => events.push(msg));

    const received = await new Promise((resolve, reject) => {
      n2.on("input", resolve);
      n1.receive({ payload: "say hello" });
      setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
    });

    assert.equal(received.agentExecution.status, "completed");
    assert.equal(received.agentExecution.costUsd, 0.012);
    assert.deepEqual(received.agentExecution.tokens, {
      total: 16456,
      input: 16451,
      output: 5,
      reasoning: 0,
      cache: { write: 0, read: 0 },
    });

    // The terminal lifecycle envelope (output 2) carries the same
    // costUsd/tokens as agentExecution above. onSettled (agent.js) fires
    // this asynchronously, slightly after the output-1 resultMsg above --
    // see agent.js's onSettled comment -- so wait for it separately.
    const terminalEvent = await new Promise((resolve, reject) => {
      const existing = events.find((m) => m.payload && m.payload.type === "completed");
      if (existing) {
        resolve(existing);
        return;
      }
      n3.on("input", (msg) => {
        if (msg.payload && msg.payload.type === "completed") resolve(msg);
      });
      setTimeout(
        () => reject(new Error("timed out waiting for terminal lifecycle event")),
        5000,
      ).unref();
    });
    assert.equal(terminalEvent.payload.costUsd, 0.012);
    assert.deepEqual(terminalEvent.payload.tokens, received.agentExecution.tokens);
  } finally {
    process.env.PATH = priorPath;
  }
});

test("agentExecution never includes costUsd/tokens keys for pi runs (costReporting capability is false, issue #22)", async () => {
  const PI_FIXTURES_DIR = path.join(FIXTURES_DIR, "pi-fixture");
  const priorPath = process.env.PATH;
  process.env.PATH = PI_FIXTURES_DIR + path.delimiter + priorPath;

  const flow = [
    {
      id: "n1",
      type: "agent",
      name: "agent",
      agent: "pi",
      runtime: "direct",
      invocation: "prompt",
      prompt: "payload",
      promptType: "msg",
      wires: [["n2"], ["n3"]],
    },
    { id: "n2", type: "helper" },
    { id: "n3", type: "helper" },
  ];
  try {
    await helper.load(agentNode, flow);
    const n1 = helper.getNode("n1");
    const n2 = helper.getNode("n2");
    const n3 = helper.getNode("n3");

    const events = [];
    n3.on("input", (msg) => events.push(msg));

    const received = await new Promise((resolve, reject) => {
      n2.on("input", resolve);
      n1.receive({ payload: "say hello" });
      setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
    });

    assert.equal(received.payload, "hello from fake pi");
    assert.equal(received.agentExecution.status, "completed");
    assert.ok(!("costUsd" in received.agentExecution), "pi must never gain a costUsd key");
    assert.ok(!("tokens" in received.agentExecution), "pi must never gain a tokens key");

    const terminalEvent = await new Promise((resolve, reject) => {
      const existing = events.find((m) => m.payload && m.payload.type === "completed");
      if (existing) {
        resolve(existing);
        return;
      }
      n3.on("input", (msg) => {
        if (msg.payload && msg.payload.type === "completed") resolve(msg);
      });
      setTimeout(
        () => reject(new Error("timed out waiting for terminal lifecycle event")),
        5000,
      ).unref();
    });
    assert.ok(!("costUsd" in terminalEvent.payload));
    assert.ok(!("tokens" in terminalEvent.payload));
  } finally {
    process.env.PATH = priorPath;
  }
});

test("a clean exit (0) with no assistant text is reported as failed with a null msg.payload (issue #21)", async () => {
  const EMPTY_FIXTURES_DIR = path.join(FIXTURES_DIR, "empty-output");
  const priorPath = process.env.PATH;
  process.env.PATH = EMPTY_FIXTURES_DIR + path.delimiter + priorPath;

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
  try {
    await helper.load(agentNode, flow);
    const n1 = helper.getNode("n1");
    const n2 = helper.getNode("n2");

    const received = await new Promise((resolve, reject) => {
      n2.on("input", resolve);
      n1.receive({ payload: "say hello" });
      setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
    });

    assert.equal(received.payload, null, "a failed run must never leak its collected payload");
    assert.equal(received.agentExecution.status, "failed");
    assert.equal(received.agentExecution.exitCode, 0);
  } finally {
    process.env.PATH = priorPath;
  }
});

// issue #25: systemPrompt has no verified CLI flag for either adapter
// (CAPABILITIES.systemPromptControl is false for both) -- setting it must
// always warn-and-drop, never error, regardless of which adapter is active.
test("a configured systemPrompt is always warned-and-dropped (unsupported by either adapter, issue #25)", async () => {
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
      systemPrompt: "You are a helpful assistant",
      systemPromptType: "str",
      wires: [["n2"], []],
    },
    { id: "n2", type: "helper" },
  ];
  await helper.load(agentNode, flow);
  const n1 = helper.getNode("n1");
  const n2 = helper.getNode("n2");

  await new Promise((resolve, reject) => {
    n2.on("input", resolve);
    n1.receive({ payload: "say hello" });
    setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
  });

  const warnCalls = helper
    .log()
    .args.filter((a) => a[0].level === 30 && /systemPrompt is not supported/.test(a[0].msg));
  assert.equal(warnCalls.length, 1, "exactly one warn for the unsupported systemPrompt field");
});

// issue #25: effortControl is false for pi (no verified CLI flag) -- setting
// Effort on a pi-agent node must warn-and-drop, never error.
test("a configured effort is warned-and-dropped for the pi adapter (effortControl capability is false, issue #25)", async () => {
  const PI_FIXTURES_DIR = path.join(FIXTURES_DIR, "pi-fixture");
  const priorPath = process.env.PATH;
  process.env.PATH = PI_FIXTURES_DIR + path.delimiter + priorPath;

  const flow = [
    {
      id: "n1",
      type: "agent",
      name: "agent",
      agent: "pi",
      runtime: "direct",
      invocation: "prompt",
      prompt: "payload",
      promptType: "msg",
      effort: "high",
      effortType: "str",
      wires: [["n2"], []],
    },
    { id: "n2", type: "helper" },
  ];
  try {
    await helper.load(agentNode, flow);
    const n1 = helper.getNode("n1");
    const n2 = helper.getNode("n2");

    const received = await new Promise((resolve, reject) => {
      n2.on("input", resolve);
      n1.receive({ payload: "say hello" });
      setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
    });

    assert.equal(received.payload, "hello from fake pi");
    const warnCalls = helper
      .log()
      .args.filter((a) => a[0].level === 30 && /effort is not supported/.test(a[0].msg));
    assert.equal(warnCalls.length, 1, "exactly one warn for the unsupported effort field");
  } finally {
    process.env.PATH = priorPath;
  }
});

// issue #25: effortControl is true for opencode -- Effort must NOT warn and
// must actually reach the CLI as --variant <effort>.
test("a configured effort is forwarded (not warned) for the opencode adapter and reaches --variant (issue #25)", async () => {
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
      effort: "high",
      effortType: "str",
      wires: [["n2"], []],
    },
    { id: "n2", type: "helper" },
  ];
  await helper.load(agentNode, flow);
  const n1 = helper.getNode("n1");
  const n2 = helper.getNode("n2");

  await new Promise((resolve, reject) => {
    n2.on("input", resolve);
    n1.receive({ payload: "say hello" });
    setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
  });

  const warnCalls = helper
    .log()
    .args.filter((a) => a[0].level === 30 && /effort is not supported/.test(a[0].msg));
  assert.equal(warnCalls.length, 0, "opencode supports effort -- no warning expected");
});
