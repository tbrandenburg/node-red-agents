"use strict";

const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const path = require("node:path");
const helper = require("node-red-node-test-helper");
const agent = require("../../agent");
const provider = require("../../../model-provider/model-provider");
const originalPath = process.env.PATH;
const digest = (key) => createHash("sha256").update(key).digest("hex");

before(async () => {
  process.env.PATH = path.join(__dirname, "../fixtures/auth-echo") + path.delimiter + originalPath;
  await helper.startServer();
});
after(async () => {
  process.env.PATH = originalPath;
  await helper.stopServer();
});
afterEach(async () => {
  await helper.unload();
  helper.settings({
    nodeRedAgentsExecutionObserver: undefined,
    nodeRedAgentsLifecycleObserver: undefined,
  });
});

async function load(options = {}) {
  await helper.load(
    [agent, provider],
    [
      { id: "p", type: "model-provider", provider: "openrouter", defaultModel: "anthropic/test" },
      {
        id: "a",
        type: "agent",
        agent: "opencode-v1",
        authMode: "provider",
        modelProvider: "p",
        retryMaxAttempts: 1,
        wires: [["out"], ["events"]],
        ...options,
      },
      { id: "out", type: "helper" },
      { id: "events", type: "helper" },
    ],
    { p: { apiKey: "synthetic-first-key" } },
  );
}

function output(count = 1) {
  return new Promise((resolve, reject) => {
    const results = [];
    const timer = setTimeout(() => reject(new Error("auth output timeout")), 5000);
    const listener = (msg) => {
      results.push(msg);
      if (results.length < count) return;
      clearTimeout(timer);
      helper.getNode("out").off("input", listener);
      resolve(results);
    };
    helper.getNode("out").on("input", listener);
  });
}

test("queued launches resolve rotated credentials and observers/results/events omit secrets and env", async () => {
  const records = [];
  helper.settings({
    nodeRedAgentsExecutionObserver: (record) => {
      records.push(record);
      helper.getNode("p").credentials.apiKey = "synthetic-second-key";
    },
    nodeRedAgentsLifecycleObserver: (record) => records.push(record),
  });
  await load();
  const events = [];
  helper.getNode("events").on("input", (msg) => events.push(msg));
  const received = output(2);
  const before = JSON.stringify({ ...process.env });
  helper.getNode("a").receive({ payload: "first" });
  helper.getNode("a").receive({ payload: "second" });
  const results = await received;
  assert.deepEqual(
    results.map((msg) => JSON.parse(msg.payload).digest),
    [digest("synthetic-first-key"), digest("synthetic-second-key")],
  );
  assert.equal(JSON.parse(results[0].payload).model, "openrouter/anthropic/test");
  assert.ok(events.some((msg) => msg.payload.type === "queued"));
  const serialized = JSON.stringify({ records, results, events });
  assert.ok(
    !serialized.includes("synthetic-first-key") && !serialized.includes("synthetic-second-key"),
  );
  assert.ok(!serialized.includes('"env"'));
  assert.ok(JSON.stringify({ ...process.env }) === before);
});

test("malicious stderr/error echoes reach Catch sanitized", { timeout: 8000 }, async () => {
  await load();
  const node = helper.getNode("a");
  const error = new Promise((resolve) => node.once("call:error", (call) => resolve(call.args[0])));
  node.receive({ payload: "fail" });
  const caught = await error;
  assert.ok(!String(caught).includes("synthetic-first-key"));
  assert.ok(String(caught).includes("[REDACTED]"));
});

test("close terminates a credential-bearing active child", { timeout: 8000 }, async () => {
  await load();
  const event = new Promise((resolve) =>
    helper.getNode("events").on("input", (msg) => {
      if (msg.payload.type === "agent") resolve();
    }),
  );
  helper.getNode("a").receive({ payload: "hang" });
  await event;
  await helper.unload();
});

test("v2 manual termination never retries with retryOnError all", { timeout: 8000 }, async () => {
  await load({ agent: "opencode-v2", retryMaxAttempts: 3, retryOnError: "all", retryDelayMs: 1 });
  const events = [];
  const results = [];
  const node = helper.getNode("a");
  helper.getNode("out").on("input", (msg) => {
    if (msg.agentExecution) results.push(msg);
  });
  const terminal = new Promise((resolve) => {
    helper.getNode("events").on("input", (msg) => {
      events.push(msg.payload.type);
      // Each child announces readiness; terminate repeated attempts too so a
      // regression fails on counts rather than leaving another hanging CLI.
      if (msg.payload.type === "agent")
        node.receive({ operation: "terminate", executionId: msg.executionId });
      if (msg.payload.type === "failed") resolve();
    });
  });
  node.receive({ payload: "hang" });
  await terminal;
  assert.equal(events.filter((type) => type === "running").length, 1);
  assert.equal(events.filter((type) => type === "agent").length, 1);
  assert.equal(events.includes("retrying"), false);
  assert.equal(results.length, 1);
  assert.equal(results[0].agentExecution.status, "failed");
  assert.equal(results[0].agentExecution.timedOut, false);
});

test("environment mode uses ambient key and ignores a missing provider reference", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "synthetic-ambient-agent";
  try {
    await load({
      authMode: "environment",
      modelProvider: "missing",
      model: "openrouter/anthropic/test",
    });
    const received = output();
    helper.getNode("a").receive({ payload: "hello" });
    const [reply] = await received;
    assert.equal(JSON.parse(reply.payload).digest, digest("synthetic-ambient-agent"));
    assert.ok(!reply.payload.includes("synthetic-ambient-agent"));
    assert.ok(process.env.OPENROUTER_API_KEY === "synthetic-ambient-agent");
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("split child text is redacted before event output and terminal observers", async () => {
  const records = [];
  helper.settings({
    nodeRedAgentsExecutionObserver: (record) => records.push(record),
    nodeRedAgentsLifecycleObserver: (record) => records.push(record),
  });
  await load();
  const events = [];
  helper.getNode("events").on("input", (msg) => events.push(msg));
  const received = output();
  helper
    .getNode("a")
    .receive({ payload: "split", token: "label", secret: 0.2, headers: ["heading"] });
  const [reply] = await received;
  const text = events
    .filter((msg) => msg.payload.data?.type === "text")
    .map((msg) => msg.payload.data.part.text)
    .join("");
  assert.equal(text, "prefix [REDACTED] suffix");
  assert.equal(reply.token, "label");
  assert.equal(reply.secret, 0.2);
  assert.deepEqual(reply.headers, ["heading"]);
  assert.ok(records.length >= 2);
  assert.ok(!JSON.stringify({ records, events, reply }).includes("synthetic-first-key"));
  assert.ok(records.some((record) => JSON.stringify(record).includes("[REDACTED]")));
});

test("Basic-auth child diagnostics cannot leak through events, results, Catch or terminal observers", async () => {
  const records = [];
  helper.settings({
    nodeRedAgentsExecutionObserver: (record) => records.push(record),
    nodeRedAgentsLifecycleObserver: (record) => records.push(record),
  });
  await load();
  const events = [];
  helper.getNode("events").on("input", (msg) => events.push(msg));
  const node = helper.getNode("a");
  const caught = new Promise((resolve) => node.once("call:error", (call) => resolve(call.args[0])));
  const received = output();
  node.receive({ payload: "basic-diagnostic", headers: ["application heading"] });
  const [[reply], error] = await Promise.all([received, caught]);
  const basic = "Basic " + Buffer.from("user:synthetic-first-key").toString("base64");
  assert.ok(!JSON.stringify({ records, events, reply, error: String(error) }).includes(basic));
  assert.equal(reply.agentExecution.errorDetail.data.headers, undefined);
  assert.deepEqual(reply.headers, ["application heading"]);
  const terminal = records.filter((record) => record.output?.errorDetail);
  assert.equal(terminal.length, 2);
  assert.ok(terminal.every((record) => record.output.errorDetail.data.headers === undefined));
  assert.equal(reply.agentExecution.errorDetail.data.message, "rejected Basic [REDACTED]");
});
