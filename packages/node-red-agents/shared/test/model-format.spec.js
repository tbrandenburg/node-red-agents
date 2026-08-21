"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { assertModelFormat } = require("../model-format");

test("empty/undefined/null are accepted (no override)", () => {
  assert.doesNotThrow(() => assertModelFormat(""));
  assert.doesNotThrow(() => assertModelFormat(undefined));
  assert.doesNotThrow(() => assertModelFormat(null));
});

test('a well-formed "provider/model" is accepted', () => {
  assert.doesNotThrow(() => assertModelFormat("github-copilot/claude-sonnet-5"));
});

test("missing separator throws a clear, actionable error", () => {
  assert.throws(() => assertModelFormat("just-a-model-no-provider"), /expected "provider\/model"/);
});

test("leading or trailing slash throws a clear error", () => {
  assert.throws(() => assertModelFormat("/model"), /expected "provider\/model"/);
  assert.throws(() => assertModelFormat("provider/"), /expected "provider\/model"/);
});

test("error message points at `opencode models` for further diagnosis", () => {
  assert.throws(() => assertModelFormat("badformat"), /opencode models/);
});
