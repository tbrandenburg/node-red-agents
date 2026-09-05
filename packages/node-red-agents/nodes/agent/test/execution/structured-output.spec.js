"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  STRUCTURED_OUTPUT_MAX_REASKS,
  compileOutputFormat,
  tryParseStructuredOutput,
  augmentPromptForSchema,
  buildReaskPrompt,
} = require("../../lib/execution/structured-output");

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

test("STRUCTURED_OUTPUT_MAX_REASKS is the fixed reask budget", () => {
  assert.equal(STRUCTURED_OUTPUT_MAX_REASKS, 3);
});

test("compileOutputFormat compiles a valid schema into a working AJV validate fn", () => {
  const { validate, error } = compileOutputFormat(SCHEMA);
  assert.equal(error, undefined);
  assert.equal(typeof validate, "function");
  assert.equal(validate({ answer: "hi" }), true);
  assert.equal(validate({ answer: 5 }), false);
});

test("compileOutputFormat returns { error } instead of throwing for a malformed schema", () => {
  const { validate, error } = compileOutputFormat({ type: "not-a-real-type" });
  assert.equal(validate, undefined);
  assert.equal(typeof error, "string");
});

test("compileOutputFormat returns { error } for a non-object schema (e.g. an array)", () => {
  const { error } = compileOutputFormat([1, 2, 3]);
  assert.equal(typeof error, "string");
});

test("tryParseStructuredOutput: clean JSON.parse of the whole text", () => {
  const parsed = tryParseStructuredOutput('{"answer":"hi"}');
  assert.deepEqual(parsed, { answer: "hi" });
});

test("tryParseStructuredOutput: strips a ```json fence before parsing", () => {
  const parsed = tryParseStructuredOutput('```json\n{"answer":"hi"}\n```');
  assert.deepEqual(parsed, { answer: "hi" });
});

test("tryParseStructuredOutput: first-brace-scan recovery for surrounding prose", () => {
  const text = 'Sure, here you go: {"answer":"hi"} -- let me know if you need anything else.';
  const parsed = tryParseStructuredOutput(text);
  assert.deepEqual(parsed, { answer: "hi" });
});

test("tryParseStructuredOutput: scans from the FIRST '{', not the last, when text has multiple objects", () => {
  const text = 'Real: {"answer":"first"} not this example: {"answer":"second"}';
  const parsed = tryParseStructuredOutput(text);
  // Slicing from the first '{' to the LAST '}' on text with two separate
  // objects and no shared nesting isn't itself valid JSON, so this
  // recovery tier correctly fails closed (undefined) rather than
  // fabricating a merged/garbled result.
  assert.equal(parsed, undefined);
});

test("tryParseStructuredOutput: unparseable text returns undefined (no jsonrepair)", () => {
  assert.equal(tryParseStructuredOutput("definitely not json"), undefined);
});

test("tryParseStructuredOutput: top-level arrays always return undefined (object-only contract)", () => {
  assert.equal(tryParseStructuredOutput("[1,2,3]"), undefined);
});

test("tryParseStructuredOutput: top-level primitives always return undefined (object-only contract)", () => {
  assert.equal(tryParseStructuredOutput("42"), undefined);
  assert.equal(tryParseStructuredOutput('"just a string"'), undefined);
  assert.equal(tryParseStructuredOutput("true"), undefined);
});

test("tryParseStructuredOutput: blank/empty text returns undefined", () => {
  assert.equal(tryParseStructuredOutput(""), undefined);
  assert.equal(tryParseStructuredOutput("   "), undefined);
  assert.equal(tryParseStructuredOutput(undefined), undefined);
});

test("augmentPromptForSchema appends the original prompt and the pretty-printed schema", () => {
  const augmented = augmentPromptForSchema("say hello", SCHEMA);
  assert.match(augmented, /^say hello/);
  assert.match(augmented, /"answer"/);
  assert.match(augmented, /JSON Schema/i);
});

test("buildReaskPrompt shape: includes original prompt, AJV error list, and schema", () => {
  const errors = [{ instancePath: "/answer", message: "must be string" }];
  const reask = buildReaskPrompt("say hello", SCHEMA, errors);
  assert.match(reask, /^say hello/);
  assert.match(reask, /\/answer must be string/);
  assert.match(reask, /"answer"/);
});

test("buildReaskPrompt handles an empty/undefined errors list gracefully", () => {
  const reask = buildReaskPrompt("say hello", SCHEMA, undefined);
  assert.match(reask, /not valid JSON/);
});
