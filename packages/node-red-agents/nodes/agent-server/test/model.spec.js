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
