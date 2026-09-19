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
