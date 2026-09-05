"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { substituteInputs } = require("../../lib/execution/inputs");

test("replaces a single $INPUTS.<name> token with its mapped value", () => {
  assert.equal(
    substituteInputs("summarize $INPUTS.topic please", { topic: "release notes" }),
    "summarize release notes please",
  );
});

test("missing key: token with no matching inputs entry is left as literal text, no throw", () => {
  assert.equal(substituteInputs("cc $INPUTS.missing", { topic: "x" }), "cc $INPUTS.missing");
  assert.equal(substituteInputs("cc $INPUTS.missing", {}), "cc $INPUTS.missing");
});

test("non-string values (numbers/booleans) are stringified", () => {
  assert.equal(
    substituteInputs("count=$INPUTS.n flag=$INPUTS.f", { n: 3, f: true }),
    "count=3 flag=true",
  );
});

test("a literal $INPUTS. with no name after it is left as-is (no token match)", () => {
  assert.equal(
    substituteInputs("path is $INPUTS. literally", { topic: "x" }),
    "path is $INPUTS. literally",
  );
});

test("multiple different $INPUTS.<name> tokens in one string all get substituted", () => {
  assert.equal(substituteInputs("$INPUTS.a and $INPUTS.b", { a: "1", b: "2" }), "1 and 2");
});

test("the same token appearing multiple times is substituted every time", () => {
  assert.equal(substituteInputs("$INPUTS.x plus $INPUTS.x", { x: "5" }), "5 plus 5");
});

test("no inputsMap (undefined/null) leaves every token unsubstituted, no throw", () => {
  assert.equal(substituteInputs("$INPUTS.topic", undefined), "$INPUTS.topic");
  assert.equal(substituteInputs("$INPUTS.topic", null), "$INPUTS.topic");
});

test("non-string text (e.g. undefined args) passes through unchanged", () => {
  assert.equal(substituteInputs(undefined, { topic: "x" }), undefined);
  assert.equal(substituteInputs("", { topic: "x" }), "");
});

test("a null/undefined value for a matched name is left as literal text rather than substituting 'null'/'undefined'", () => {
  assert.equal(substituteInputs("$INPUTS.a", { a: null }), "$INPUTS.a");
  assert.equal(substituteInputs("$INPUTS.a", { a: undefined }), "$INPUTS.a");
});
