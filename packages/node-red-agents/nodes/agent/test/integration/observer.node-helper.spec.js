"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, after, afterEach, test } = require("node:test");
const helper = require("node-red-node-test-helper");
const agentNode = require("../../agent.js");

const fixtures = path.join(__dirname, "..", "fixtures");
const originalPath = process.env.PATH;

function flow(options = {}) {
  return [
    {
      id: "n1",
      type: "agent",
      name: "worker",
      agent: "opencode",
      runtime: "direct",
      prompt: "payload",
      promptType: "msg",
      wires: [["output"], ["events"]],
      ...options,
    },
    { id: "output", type: "helper" },
    { id: "events", type: "helper" },
  ];
}

function receive(node, msg) {
  return new Promise((resolve, reject) => {
    node.once("input", resolve);
    setTimeout(() => reject(new Error("timed out waiting for result")), 5000).unref();
    helper.getNode("n1").receive(msg);
  });
}

before(async () => {
  process.env.PATH = fixtures + path.delimiter + originalPath;
  await helper.startServer();
});

after(async () => {
  process.env.PATH = originalPath;
  await helper.stopServer();
});

afterEach(async () => {
  await helper.unload();
  helper.settings({ nodeRedAgentsExecutionObserver: undefined });
});

test("observer acknowledgment precedes delivery; parallel nodes and overlapping inputs have distinct records", async () => {
  const observations = [];
  const acknowledgments = [];
  helper.settings({
    nodeRedAgentsExecutionObserver: (record) => {
      observations.push(record);
      return new Promise((resolve) => acknowledgments.push(resolve));
    },
  });
  const graph = flow({ concurrency: 2 });
  graph[0].wires = [["output"], []];
  graph.push({ ...graph[0], id: "n3", name: "second", wires: [["output"], []] });
  await helper.load(agentNode, graph);
  const output = helper.getNode("output");
  const delivered = [];
  output.on("input", (msg) => delivered.push(msg));
  for (const id of ["n1", "n3"]) {
    for (let index = 0; index < 2; index += 1) {
      helper.getNode(id).receive({
        payload: `prompt-${id}-${index}`,
        agentObservation: { origin: `${id}-${index}`, nested: [1, null] },
        privateField: "never forward this",
      });
    }
  }
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("timed out waiting for observations")),
      5000,
    );
    const poll = () => {
      if (observations.length === 4) {
        clearTimeout(deadline);
        resolve();
      } else setTimeout(poll, 10);
    };
    poll();
  });
  assert.equal(delivered.length, 0);
  assert.equal(new Set(observations.map((record) => record.eventId)).size, 4);
  assert.equal(new Set(observations.map((record) => record.executionId)).size, 4);
  for (const record of observations) {
    assert.equal(record.version, 1);
    assert.match(record.eventId, /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(record.timestamp)));
    assert.equal(record.status, "completed");
    assert.equal(record.agent, "opencode");
    assert.equal(record.agentName, record.nodeId === "n1" ? "worker" : "second");
    assert.deepEqual(record.input, {
      invocation: "prompt",
      prompt: `prompt-${record.agentObservation.origin}`,
    });
    assert.equal(record.output.payload, "hello from fake opencode");
    assert.equal(record.sessionID, "fake-session-id");
    assert.deepEqual(record.agentObservation.nested, [1, null]);
    assert.ok(!("privateField" in record));
  }
  const results = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("timed out waiting for results")), 5000);
    const check = () => {
      if (delivered.length === 4) {
        clearTimeout(deadline);
        resolve();
      }
    };
    output.on("input", check);
  });
  acknowledgments.forEach((acknowledge) => acknowledge());
  await results;
  assert.deepEqual(
    new Set(delivered.map((msg) => msg.agentExecution.id)),
    new Set(observations.map((record) => record.executionId)),
  );
});

test("rejection is catchable without a result or agent retry and retains the actual outcome", async () => {
  const stateFile = path.join(os.tmpdir(), `observer-retry-${process.pid}-${Date.now()}`);
  const previousPath = process.env.PATH;
  process.env.PATH = path.join(fixtures, "retry-transient") + path.delimiter + previousPath;
  process.env.RETRY_FIXTURE_STATE = stateFile;
  process.env.RETRY_FIXTURE_FAIL_COUNT = "1";
  const records = [];
  helper.settings({
    nodeRedAgentsExecutionObserver: (record) => {
      records.push(record);
      throw new Error("history unavailable");
    },
  });
  try {
    await helper.load(
      agentNode,
      flow({ retryMaxAttempts: 3, retryOnError: "all", retryDelayMs: 1 }),
    );
    const node = helper.getNode("n1");
    const delivered = [];
    helper.getNode("output").on("input", (msg) => delivered.push(msg));
    const caught = new Promise((resolve) => node.once("call:error", resolve));
    node.receive({ payload: "say hello" });
    const error = (await caught).args[0];
    assert.match(error.message, /observer failed.*status=completed.*history unavailable/);
    assert.equal(error.agentOutcome.status, "completed");
    assert.equal(error.agentOutcome.payload, "hello after 2 attempts");
    assert.equal(error.cause.agentOutcome.status, "completed");
    assert.equal(delivered.length, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, "completed");
    assert.equal(fs.readFileSync(stateFile, "utf8"), "2");
  } finally {
    process.env.PATH = previousPath;
    delete process.env.RETRY_FIXTURE_STATE;
    delete process.env.RETRY_FIXTURE_FAIL_COUNT;
    fs.rmSync(stateFile, { force: true });
  }
});

test("failed runs are observed before their existing failure result and Catch error", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = path.join(fixtures, "retry-fatal") + path.delimiter + previousPath;
  process.env.RETRY_FIXTURE_STATE = path.join(
    os.tmpdir(),
    `observer-failure-${process.pid}-${Date.now()}`,
  );
  const seen = [];
  helper.settings({ nodeRedAgentsExecutionObserver: (record) => seen.push(record) });
  try {
    await helper.load(agentNode, flow());
    const node = helper.getNode("n1");
    const caught = new Promise((resolve) => node.once("call:error", resolve));
    const result = await receive(helper.getNode("output"), { payload: "bad request" });
    assert.equal(result.payload, null);
    assert.equal(result.agentExecution.status, "failed");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].status, "failed");
    assert.match(seen[0].output.errorMessage, /401|unauthorized/i);
    assert.equal(seen[0].input.prompt, "bad request");
    assert.match(String((await caught).args[0]), /failed/);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(process.env.RETRY_FIXTURE_STATE, { force: true });
    delete process.env.RETRY_FIXTURE_STATE;
  }
});

test("command observation contains resolved substituted arguments; no observer preserves result", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = path.join(fixtures, "echo-args") + path.delimiter + previousPath;
  const records = [];
  helper.settings({ nodeRedAgentsExecutionObserver: (record) => records.push(record) });
  try {
    await helper.load(
      agentNode,
      flow({
        invocation: "command",
        invocationName: "review",
        invocationNameType: "str",
        arguments: "check $INPUTS.topic",
        argumentsType: "str",
        promptArgs: [{ name: "topic", value: "payload", valueType: "msg" }],
      }),
    );
    await receive(helper.getNode("output"), { payload: "release" });
    assert.deepEqual(records[0].input, {
      invocation: "command",
      name: "review",
      args: "check release",
    });
    await helper.unload();
    helper.settings({ nodeRedAgentsExecutionObserver: undefined });
    process.env.PATH = previousPath;
    await helper.load(agentNode, flow());
    const result = await receive(helper.getNode("output"), { payload: "hello" });
    assert.equal(result.payload, "hello from fake opencode");
    assert.equal(records.length, 1);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("structured-output reasks produce one final observation with canonical output and confirmed resume", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = path.join(fixtures, "structured-output-reask") + path.delimiter + previousPath;
  const records = [];
  helper.settings({ nodeRedAgentsExecutionObserver: (record) => records.push(record) });
  try {
    await helper.load(
      agentNode,
      flow({
        outputFormat: JSON.stringify({
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        }),
      }),
    );
    const result = await receive(helper.getNode("output"), {
      payload: "answer this",
      sessionID: "fake-session-id",
    });
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].input, { invocation: "prompt", prompt: "answer this" });
    assert.equal(records[0].output.payload, JSON.stringify({ answer: "hello" }));
    assert.deepEqual(records[0].output.structuredOutput, { answer: "hello" });
    assert.equal(records[0].resumed, result.agentExecution.resumed);
    assert.equal(records[0].sessionID, result.sessionID);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("non-serializable correlation is rejected before an execution starts", async () => {
  const records = [];
  helper.settings({ nodeRedAgentsExecutionObserver: (record) => records.push(record) });
  await helper.load(agentNode, flow());
  const node = helper.getNode("n1");
  const caught = new Promise((resolve) => node.once("call:error", resolve));
  node.receive({ payload: "hello", agentObservation: { invalid: 1n } });
  assert.match((await caught).args[0].message, /agentObservation must be JSON-serializable/);
  assert.equal(node.scheduler.activeCount, 0);
  assert.equal(records.length, 0);
});

test("timed-out executions are observed before delivering their failure result", async () => {
  const records = [];
  helper.settings({ nodeRedAgentsExecutionObserver: (record) => records.push(record) });
  await helper.load(agentNode, flow({ timeout: "0.001", timeoutType: "num", retryMaxAttempts: 1 }));
  const result = await receive(helper.getNode("output"), { payload: "slow" });
  assert.equal(result.agentExecution.status, "timeout");
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "timeout");
  assert.equal(records[0].output.timedOut, true);
});
