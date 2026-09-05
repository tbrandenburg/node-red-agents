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
const fs = require("node:fs");
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

// issue #23: output_format (JSON Schema) + AJV validation + best-effort
// reask loop. All three fixtures below are fixed opencode CLI stand-ins
// under ../fixtures/structured-output-*; see each fixture's own header
// comment for exactly what it emits and why.
const OUTPUT_FORMAT_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

test("output_format: valid JSON on the first attempt sets canonical payload + agentExecution.structuredOutput (issue #23)", async () => {
  const FIXTURES = path.join(FIXTURES_DIR, "structured-output-valid");
  const priorPath = process.env.PATH;
  process.env.PATH = FIXTURES + path.delimiter + priorPath;

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
      outputFormat: JSON.stringify(OUTPUT_FORMAT_SCHEMA),
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
      n1.receive({ payload: "give me an answer" });
      setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
    });

    assert.equal(received.payload, JSON.stringify({ answer: "hello" }));
    assert.equal(received.agentExecution.status, "completed");
    assert.deepEqual(received.agentExecution.structuredOutput, { answer: "hello" });
    assert.deepEqual(received.agentExecution.declaredFields, ["answer"]);
  } finally {
    process.env.PATH = priorPath;
  }
});

test("output_format: invalid JSON that becomes valid on a reask retry still succeeds (issue #23)", async () => {
  const FIXTURES = path.join(FIXTURES_DIR, "structured-output-reask");
  const priorPath = process.env.PATH;
  process.env.PATH = FIXTURES + path.delimiter + priorPath;

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
      outputFormat: JSON.stringify(OUTPUT_FORMAT_SCHEMA),
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
      n1.receive({ payload: "give me an answer" });
      setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
    });

    assert.equal(received.payload, JSON.stringify({ answer: "hello" }));
    assert.equal(received.agentExecution.status, "completed");
    assert.deepEqual(received.agentExecution.structuredOutput, { answer: "hello" });
  } finally {
    process.env.PATH = priorPath;
  }
});

test("output_format: never producing valid JSON within the reask budget fails with a null payload (issue #23)", async () => {
  const FIXTURES = path.join(FIXTURES_DIR, "structured-output-never-valid");
  const priorPath = process.env.PATH;
  process.env.PATH = FIXTURES + path.delimiter + priorPath;

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
      outputFormat: JSON.stringify(OUTPUT_FORMAT_SCHEMA),
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
      n1.receive({ payload: "give me an answer" });
      setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
    });

    assert.equal(received.payload, null, "a failed run must never leak its raw text");
    assert.equal(received.agentExecution.status, "failed");
    assert.ok(!("structuredOutput" in received.agentExecution));
  } finally {
    process.env.PATH = priorPath;
  }
});

test("output_format unset: zero behavior change (no structuredOutput/declaredFields keys)", async () => {
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
  assert.ok(!("structuredOutput" in received.agentExecution));
  assert.ok(!("declaredFields" in received.agentExecution));
});

test("output_format: an invalid JSON Schema at deploy time sets a red status and refuses to run (issue #23)", async () => {
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
      outputFormat: "{ not valid json",
      wires: [["n2"], []],
    },
    { id: "n2", type: "helper" },
  ];
  await helper.load(agentNode, flow);
  const n1 = helper.getNode("n1");

  assert.match(n1.outputFormatError, /invalid output_format schema/);

  const done = await new Promise((resolve) => {
    n1.receive({ payload: "say hello" });
    setTimeout(() => resolve(), 200).unref();
  });
  void done;

  const errorLogs = helper
    .log()
    .args.filter((a) => a[0].level === 20 && /invalid output_format schema/.test(a[0].msg));
  assert.ok(errorLogs.length >= 1, "deploy-time bad schema logs an error");
});

// issue #24: node-level retry (max_attempts/delay_ms/on_error) with
// transient-vs-fatal classification. Fixtures live under
// ../fixtures/retry-transient (fails N times with a transient-looking
// error then succeeds) and ../fixtures/retry-fatal (always fails with a
// fatal-looking 401); see each fixture's own header comment.
const os = require("node:os");

function freshStateFile() {
  return path.join(
    os.tmpdir(),
    `retry-fixture-state-${process.pid}-${Date.now()}-${Math.random()}`,
  );
}

test("retry: a transient error is retried (default onError:'transient') until it succeeds, with an intermediate 'retrying' event", async () => {
  const FIXTURES = path.join(FIXTURES_DIR, "retry-transient");
  const priorPath = process.env.PATH;
  const stateFile = freshStateFile();
  process.env.PATH = FIXTURES + path.delimiter + priorPath;
  process.env.RETRY_FIXTURE_STATE = stateFile;
  process.env.RETRY_FIXTURE_FAIL_COUNT = "1";

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
      retryMaxAttempts: 2,
      retryDelayMs: 10,
      retryOnError: "transient",
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
    assert.equal(received.payload, "hello after 2 attempts");

    const retryingEvent = events.find((m) => m.payload && m.payload.type === "retrying");
    assert.ok(retryingEvent, "an intermediate 'retrying' lifecycle event was emitted on output 2");
    assert.equal(retryingEvent.payload.attempt, 2);
    assert.equal(retryingEvent.payload.maxAttempts, 2);

    assert.equal(fs.readFileSync(stateFile, "utf8"), "2", "the fixture ran exactly twice");
  } finally {
    process.env.PATH = priorPath;
    delete process.env.RETRY_FIXTURE_STATE;
    delete process.env.RETRY_FIXTURE_FAIL_COUNT;
    fs.rmSync(stateFile, { force: true });
  }
});

test("retry: session-reuse-on-retry -- the failed attempt's sessionID is resumed (--session) on the next attempt for opencode", async () => {
  const FIXTURES = path.join(FIXTURES_DIR, "retry-transient");
  const priorPath = process.env.PATH;
  const stateFile = freshStateFile();
  process.env.PATH = FIXTURES + path.delimiter + priorPath;
  process.env.RETRY_FIXTURE_STATE = stateFile;
  process.env.RETRY_FIXTURE_FAIL_COUNT = "1";

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
      retryMaxAttempts: 2,
      retryDelayMs: 10,
      retryOnError: "transient",
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

    // The fixture only echoes back a resumed sessionID (rather than
    // minting a new fixture-session-attempt-<n> one) when it was invoked
    // with --session <the-failed-attempt's-sessionID> -- see the
    // fixture's own header comment.
    assert.equal(received.agentExecution.status, "completed");
    assert.equal(received.sessionID, "fixture-session-attempt-1");
  } finally {
    process.env.PATH = priorPath;
    delete process.env.RETRY_FIXTURE_STATE;
    delete process.env.RETRY_FIXTURE_FAIL_COUNT;
    fs.rmSync(stateFile, { force: true });
  }
});

test("retry: a fatal error (e.g. 401) is never retried, even with attempts remaining", async () => {
  const FIXTURES = path.join(FIXTURES_DIR, "retry-fatal");
  const priorPath = process.env.PATH;
  const stateFile = freshStateFile();
  process.env.PATH = FIXTURES + path.delimiter + priorPath;
  process.env.RETRY_FIXTURE_STATE = stateFile;

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
      retryMaxAttempts: 3,
      retryDelayMs: 10,
      retryOnError: "transient",
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

    assert.equal(received.agentExecution.status, "failed");
    assert.equal(
      fs.readFileSync(stateFile, "utf8"),
      "1",
      "the fatal-error fixture ran exactly once -- no retry",
    );
  } finally {
    process.env.PATH = priorPath;
    delete process.env.RETRY_FIXTURE_STATE;
    fs.rmSync(stateFile, { force: true });
  }
});

test("retry: retryOnError:'all' retries a non-fatal, non-transient (UNKNOWN-classified) error too", async () => {
  const FIXTURES = path.join(FIXTURES_DIR, "retry-transient");
  const priorPath = process.env.PATH;
  const stateFile = freshStateFile();
  process.env.PATH = FIXTURES + path.delimiter + priorPath;
  process.env.RETRY_FIXTURE_STATE = stateFile;
  process.env.RETRY_FIXTURE_FAIL_COUNT = "2";

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
      retryMaxAttempts: 3,
      retryDelayMs: 10,
      retryOnError: "all",
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

    assert.equal(received.agentExecution.status, "completed");
    assert.equal(fs.readFileSync(stateFile, "utf8"), "3", "retried twice, succeeded on attempt 3");
  } finally {
    process.env.PATH = priorPath;
    delete process.env.RETRY_FIXTURE_STATE;
    delete process.env.RETRY_FIXTURE_FAIL_COUNT;
    fs.rmSync(stateFile, { force: true });
  }
});

test("retry: default retryMaxAttempts (2) with a persistently transient error stops after 2 attempts and reports failed", async () => {
  const FIXTURES = path.join(FIXTURES_DIR, "retry-transient");
  const priorPath = process.env.PATH;
  const stateFile = freshStateFile();
  process.env.PATH = FIXTURES + path.delimiter + priorPath;
  process.env.RETRY_FIXTURE_STATE = stateFile;
  process.env.RETRY_FIXTURE_FAIL_COUNT = "99"; // always fails

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
      // retryMaxAttempts/retryDelayMs/retryOnError all left at their
      // node.js defaults (2 / 3000 / 'transient') -- override only the
      // delay (via a tiny override) so the test doesn't wait 3s for real.
      retryDelayMs: 10,
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

    assert.equal(received.agentExecution.status, "failed");
    assert.equal(
      fs.readFileSync(stateFile, "utf8"),
      "2",
      "default retryMaxAttempts=2 means 1 original + 1 retry, then give up",
    );
  } finally {
    process.env.PATH = priorPath;
    delete process.env.RETRY_FIXTURE_STATE;
    delete process.env.RETRY_FIXTURE_FAIL_COUNT;
    fs.rmSync(stateFile, { force: true });
  }
});

test("a node-level 'inputs' config substitutes $INPUTS.<name> into the resolved args before invocation (issue #20)", async () => {
  const ECHO_ARGS_FIXTURES_DIR = path.join(FIXTURES_DIR, "echo-args");
  const priorPath = process.env.PATH;
  process.env.PATH = ECHO_ARGS_FIXTURES_DIR + path.delimiter + priorPath;

  const flow = [
    {
      id: "n1",
      type: "agent",
      name: "agent",
      agent: "opencode",
      runtime: "direct",
      invocation: "command",
      invocationName: "review",
      invocationNameType: "str",
      arguments: "summarize $INPUTS.topic please, cc $INPUTS.missing",
      argumentsType: "str",
      inputs: [{ name: "topic", value: "payload.topic", valueType: "msg" }],
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
      n1.receive({ payload: { topic: "the release notes" } });
      setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
    });

    const echoedArgv = JSON.parse(received.payload);
    const argsIndex = echoedArgv.indexOf("--command");
    assert.equal(echoedArgv[argsIndex + 1], "review");
    assert.equal(
      echoedArgv[argsIndex + 2],
      "summarize the release notes please, cc $INPUTS.missing",
      "$INPUTS.topic is substituted; an unmatched $INPUTS.<name> token is left as literal text",
    );
  } finally {
    process.env.PATH = priorPath;
  }
});

// issue #29: an unmatched $INPUTS.<name> token must not change the run's
// outcome (still completes, literal token still reaches the invocation args)
// but must surface exactly one node.warn naming the mistyped token.
test("a mistyped $INPUTS.<name> token warns once but does not change the run's outcome (issue #29)", async () => {
  const ECHO_ARGS_FIXTURES_DIR = path.join(FIXTURES_DIR, "echo-args");
  const priorPath = process.env.PATH;
  process.env.PATH = ECHO_ARGS_FIXTURES_DIR + path.delimiter + priorPath;

  const flow = [
    {
      id: "n1",
      type: "agent",
      name: "agent",
      agent: "opencode",
      runtime: "direct",
      invocation: "command",
      invocationName: "review",
      invocationNameType: "str",
      arguments: "summarize $INPUTS.topik please",
      argumentsType: "str",
      inputs: [{ name: "topic", value: "payload.topic", valueType: "msg" }],
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
      n1.receive({ payload: { topic: "the release notes" } });
      setTimeout(() => reject(new Error("timed out waiting for agent node output")), 5000).unref();
    });

    const echoedArgv = JSON.parse(received.payload);
    const argsIndex = echoedArgv.indexOf("--command");
    assert.equal(echoedArgv[argsIndex + 1], "review");
    assert.equal(
      echoedArgv[argsIndex + 2],
      "summarize $INPUTS.topik please",
      "the run completes as before -- the mistyped token still reaches the invocation as literal text",
    );

    const warnCalls = helper
      .log()
      .args.filter(
        (a) => a[0].level === 30 && /\$INPUTS\.topik has no matching 'inputs' entry/.test(a[0].msg),
      );
    assert.equal(warnCalls.length, 1, "exactly one warn naming the mistyped token");
  } finally {
    process.env.PATH = priorPath;
  }
});
