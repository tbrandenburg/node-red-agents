"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runAgent } = require("../../lib/execution/lifecycle");

function fakeAdapter({ resultOverride } = {}) {
  return {
    validate() {},
    buildExecution() {
      return { command: "fake", args: [], env: {} };
    },
    parseEvent(line) {
      return JSON.parse(line);
    },
    parseResult(events, exitCode, _signal, _stderr) {
      if (resultOverride) return resultOverride;
      return {
        payload: events.map((e) => e.data.text).join(""),
        status: exitCode === 0 ? "completed" : "failed",
      };
    },
  };
}

function fakeRuntime({ lines = [], outcome = { exitCode: 0, signal: null, stderr: "" } } = {}) {
  return {
    async execute(_executionRequest, handlers) {
      for (const line of lines) {
        handlers.onLine(JSON.stringify(line));
      }
      return outcome;
    },
  };
}

// High-signal test (5/5): the dual-output + status contract is the
// integration seam every downstream flow depends on -- one event per parsed
// line (output 2), exactly one final result after exit (output 1), and
// status transitions in the right order.
test("emits one onEvent per parsed line, then a single final result with status completed", async () => {
  const events = [];
  const statuses = [];

  const result = await runAgent({
    adapter: fakeAdapter(),
    runtime: fakeRuntime({
      lines: [
        { type: "agent", data: { text: "Hello" } },
        { type: "agent", data: { text: "World" } },
      ],
    }),
    resolved: {},
    executionId: "e1",
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
  });

  assert.equal(events.length, 2);
  assert.deepEqual(statuses, ["running", "completed"]);
  assert.equal(result.status, "completed");
  assert.equal(result.payload, "HelloWorld");
  assert.equal(result.events.length, 2);
  assert.ok(typeof result.durationMs === "number" && result.durationMs >= 0);
});

test('a failed adapter result surfaces as status "failed" with an errorMessage', async () => {
  const statuses = [];
  const result = await runAgent({
    adapter: fakeAdapter({
      resultOverride: { payload: "", status: "failed", errorMessage: "boom" },
    }),
    runtime: fakeRuntime({ outcome: { exitCode: 1, signal: null, stderr: "" } }),
    resolved: {},
    executionId: "e2",
    onEvent: () => {},
    onStatus: (s) => statuses.push(s),
  });

  assert.deepEqual(statuses, ["running", "failed"]);
  assert.equal(result.status, "failed");
  assert.equal(result.errorMessage, "boom");
});

test("runtime timedOut always wins the final status, even if the adapter thinks it completed", async () => {
  const statuses = [];
  const result = await runAgent({
    adapter: fakeAdapter({ resultOverride: { payload: "partial", status: "completed" } }),
    runtime: fakeRuntime({
      outcome: { exitCode: null, signal: "SIGKILL", stderr: "", timedOut: true },
    }),
    resolved: {},
    executionId: "e3",
    onEvent: () => {},
    onStatus: (s) => statuses.push(s),
  });

  assert.deepEqual(statuses, ["running", "timeout"]);
  assert.equal(result.status, "timeout");
  assert.equal(result.timedOut, true);
});

test('adapter.validate() throwing prevents any execution (no onStatus("running"), rejects synchronously)', async () => {
  const statuses = [];
  const adapter = {
    validate() {
      throw new Error("bad cwd");
    },
    buildExecution() {
      throw new Error("should never be called");
    },
  };
  const runtime = {
    async execute() {
      throw new Error("should never be called");
    },
  };

  await assert.rejects(
    runAgent({
      adapter,
      runtime,
      resolved: {},
      executionId: "e4",
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
    }),
    /bad cwd/,
  );
  assert.deepEqual(statuses, []);
});

test("a single malformed line from the runtime does not crash the run (adapter.parseEvent errors are swallowed)", async () => {
  const adapter = fakeAdapter();
  const originalParseEvent = adapter.parseEvent;
  adapter.parseEvent = (line) => {
    if (line === "BOOM") throw new Error("simulated parse crash");
    return originalParseEvent(line);
  };

  const runtime = {
    async execute(_req, handlers) {
      handlers.onLine("BOOM");
      handlers.onLine(JSON.stringify({ type: "agent", data: { text: "ok" } }));
      return { exitCode: 0, signal: null, stderr: "" };
    },
  };

  const events = [];
  const result = await runAgent({
    adapter,
    runtime,
    resolved: {},
    executionId: "e5",
    onEvent: (e) => events.push(e),
    onStatus: () => {},
  });

  assert.equal(events.length, 1, "only the well-formed line should produce an event");
  assert.equal(result.status, "completed");
});
