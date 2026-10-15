"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseModel } = require("../lib/model");

test("empty/undefined/null -> undefined (no model override, let opencode use its own default)", () => {
  assert.equal(parseModel(""), undefined);
  assert.equal(parseModel(undefined), undefined);
  assert.equal(parseModel(null), undefined);
});

test('"provider/model" splits into { providerID, modelID }', () => {
  assert.deepEqual(parseModel("github-copilot/claude-sonnet-4.6"), {
    providerID: "github-copilot",
    modelID: "claude-sonnet-4.6",
  });
});

test('only the first "/" is a separator -- modelID may itself contain slashes', () => {
  assert.deepEqual(parseModel("opencode/some/nested/model"), {
    providerID: "opencode",
    modelID: "some/nested/model",
  });
});

test("missing separator throws a clear error", () => {
  assert.throws(() => parseModel("just-a-model-no-provider"), /expected "provider\/model"/);
});

test("leading or trailing slash throws a clear error", () => {
  assert.throws(() => parseModel("/model"), /expected "provider\/model"/);
  assert.throws(() => parseModel("provider/"), /expected "provider\/model"/);
});

test("v2 models split nested IDs and variants without changing the legacy modelID", () => {
  assert.deepEqual(parseModel("openrouter/openai/test#high", 2), {
    providerID: "openrouter",
    modelID: "openai/test",
    variant: "high",
  });
  assert.deepEqual(parseModel("openrouter/openai/test#high"), {
    providerID: "openrouter",
    modelID: "openai/test#high",
  });
  assert.deepEqual(parseModel("openai/test", 2), { providerID: "openai", modelID: "test" });
  assert.equal(parseModel("", 2), undefined);
  for (const value of ["openai/test#", "openai/test#low#high", "openai#high/test", "openai/#high"])
    assert.throws(() => parseModel(value, 2), /invalid model/);
});
