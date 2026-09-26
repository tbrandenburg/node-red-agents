"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  registerAgent,
  isRegisteredAgent,
  getAgentAdapter,
  listAgentIds,
  resetRegistryForTests,
} = require("../../lib/agents/registry");

test("registerAgent + getAgentAdapter: registers and resolves an adapter factory", () => {
  resetRegistryForTests();
  class FakeAdapter {}
  registerAgent({ id: "fake", factory: () => new FakeAdapter() });

  assert.equal(isRegisteredAgent("fake"), true);
  assert.ok(getAgentAdapter("fake") instanceof FakeAdapter);
  assert.deepEqual(listAgentIds(), ["fake"]);
});

test("registerAgent: is idempotent for a duplicate id", () => {
  resetRegistryForTests();
  let calls = 0;
  registerAgent({
    id: "dup",
    factory: () => {
      calls += 1;
      return {};
    },
  });
  registerAgent({
    id: "dup",
    factory: () => {
      throw new Error("should never be called: first registration wins");
    },
  });

  getAgentAdapter("dup");
  assert.equal(calls, 1);
});

test("registerAgent: throws if factory is not a function", () => {
  resetRegistryForTests();
  assert.throws(() => registerAgent({ id: "bad", factory: null }), /factory must be a function/);
});

test("isRegisteredAgent: returns false for an unknown id", () => {
  resetRegistryForTests();
  assert.equal(isRegisteredAgent("nope"), false);
});

test("getAgentAdapter: throws a clear, listing error for an unknown id", () => {
  resetRegistryForTests();
  registerAgent({ id: "known", factory: () => ({}) });

  assert.throws(() => getAgentAdapter("unknown"), /unknown agent 'unknown'.*known/);
});

test("getAgentAdapter: lists '(none)' when the registry is empty", () => {
  resetRegistryForTests();
  assert.throws(() => getAgentAdapter("anything"), /\(none\)/);
});

// Issue #54: opencode.js registers three ids off the same OpenCodeAdapter
// class. resetRegistryForTests() above wipes the registry populated by
// require("../../lib/agents/opencode") at file-load time (agent.js's own
// `require("./lib/agents/opencode")` side effect), so the module's
// require-cache entry is dropped here to force its registration code to
// re-run against the freshly reset registry.
test("opencode.js registers opencode/opencode-v1/opencode-v2, and the v1/v2 ids never auto-detect", () => {
  resetRegistryForTests();
  delete require.cache[require.resolve("../../lib/agents/opencode")];
  require("../../lib/agents/opencode");

  assert.equal(isRegisteredAgent("opencode"), true);
  assert.equal(isRegisteredAgent("opencode-v1"), true);
  assert.equal(isRegisteredAgent("opencode-v2"), true);

  // resolveVersion({}) with no openCodeVersionMode and no real `opencode`
  // binary on PATH would throw/fall back to 1 via auto-detect for the
  // plain "opencode" id -- v1/v2 must short-circuit before any of that.
  assert.equal(getAgentAdapter("opencode-v1").resolveVersion({}), 1);
  assert.equal(getAgentAdapter("opencode-v2").resolveVersion({}), 2);
});
