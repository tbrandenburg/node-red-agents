"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { harness, deferred } = require("./fixtures/sanitizer-lifecycle");

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("repeated terminate releases retired sanitizers after sanitizing termination output", async () => {
  const h = harness();
  for (let index = 0; index < 30; index++) {
    const key = `synthetic-retired-${index}-key`;
    h.state.key = key;
    const reply = await h.input({ payload: "hello" });
    assert.equal(reply.error, undefined);
    const sessionID = reply.sent[0][0].sessionID;
    assert.equal(await h.status(key), "[REDACTED]");
    const terminated = await h.input({ operation: "terminate", sessionID, text: key, topic: key });
    assert.equal(terminated.sent[0][0].text, "[REDACTED]");
    assert.equal(h.outputs.at(-1)[1].topic, "[REDACTED]");
    const counts = h.spies.map((spy) => spy.calls);
    assert.equal(await h.status(key), key);
    assert.deepEqual(
      h.spies.map((spy) => spy.calls),
      counts,
    );
  }
  await h.close();
});

for (const failure of ["spawn", "health", "session"]) {
  test(`${failure} failure sanitizes its error then releases pending ownership`, async () => {
    const h = harness();
    h.state.failure = failure;
    const reply = await h.input({ payload: "hello" });
    assert.match(reply.error.message, /\[REDACTED\]/);
    assert.equal(h.node.registry.size(), 0);
    assert.ok(h.children.every((child) => child.exitCode === 0));
    const counts = h.spies.map((spy) => spy.calls);
    assert.equal(await h.status(h.state.key), h.state.key);
    assert.deepEqual(
      h.spies.map((spy) => spy.calls),
      counts,
    );
    await h.close();
  });
}

test("concurrent pending startup retains each key independently and daemon diagnostics stay local", async () => {
  const h = harness();
  h.state.health = deferred();
  const first = h.input({ payload: "hello" });
  await tick();
  h.state.key = "synthetic-second";
  const second = h.input({ payload: "hello" });
  await tick();
  assert.equal(await h.status("synthetic-first synthetic-second"), "[REDACTED] [REDACTED]");
  assert.equal(
    h.children[0].sanitize("synthetic-first synthetic-second"),
    "[REDACTED] synthetic-second",
  );
  h.state.health.resolve();
  const [firstReply] = await Promise.all([first, second]);
  assert.equal(h.node.registry.size(), 2);
  await h.input({ operation: "terminate", sessionID: firstReply.sent[0][0].sessionID });
  assert.equal(await h.status("synthetic-first synthetic-second"), "synthetic-first [REDACTED]");
  await h.close();
  assert.equal(
    await h.status("synthetic-first synthetic-second"),
    "synthetic-first synthetic-second",
  );
});

test("unexpected exit releases idle daemon ownership and registry routing", async () => {
  const h = harness();
  await h.input({ payload: "hello" });
  h.children[0].exitCode = 1;
  h.children[0].emit("exit", 1);
  assert.equal(h.node.registry.size(), 0);
  assert.equal(await h.status(h.state.key), h.state.key);
  await h.close();
});

for (const stage of ["health", "session"]) {
  test(`close during pending ${stage} kills owned child and prevents late registration`, async () => {
    const h = harness();
    h.state[stage] = deferred();
    const pending = h.input({ payload: "hello", text: h.state.key });
    await tick();
    const closing = h.close();
    h.state[stage].resolve();
    const reply = await pending;
    await closing;
    assert.ok(reply.error);
    assert.equal(h.children[0].exitCode, 0);
    assert.equal(h.node.registry.size(), 0);
    assert.equal(await h.status(h.state.key), h.state.key);
  });
}

test("unexpected exit during a request releases aggregate ownership but sanitizes the late error", async () => {
  const h = harness();
  const reply = await h.input({ payload: "hello" });
  h.state.response = deferred();
  h.state.failure = "message";
  const pending = h.input({
    payload: "hello",
    sessionID: reply.sent[0][0].sessionID,
    topic: h.state.key,
  });
  await tick();
  h.children[0].exitCode = 1;
  h.children[0].emit("exit", 1);
  assert.equal(await h.status(h.state.key), h.state.key);
  h.state.response.resolve();
  const failed = await pending;
  assert.match(failed.error.message, /\[REDACTED\]/);
  assert.ok(!failed.error.message.includes(h.state.key));
  assert.equal(h.outputs.at(-1)[1].topic, "[REDACTED]");
  await h.close();
});

test("close releases active ownership after its closed event is sanitized", async () => {
  const h = harness();
  await h.input({ payload: "hello" });
  h.node.serverName = h.state.key;
  await h.close();
  assert.equal(h.outputs.at(-1)[1].serverName, "[REDACTED]");
  assert.equal(await h.status(h.state.key), h.state.key);
});
