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

// issue #29: onUnmatched(name) is an optional third argument -- reported for
// every token left as literal text (missing key, or matched-but-null/undefined
// value), and never called for a token that actually substitutes. The
// substituted text output must stay byte-identical to the pre-#29 behavior
// in every case above and below.
test("onUnmatched is called with the name of a token missing from inputsMap", () => {
  const unmatched = [];
  const result = substituteInputs("cc $INPUTS.missing", { topic: "x" }, (name) =>
    unmatched.push(name),
  );
  assert.equal(result, "cc $INPUTS.missing");
  assert.deepEqual(unmatched, ["missing"]);
});

test("onUnmatched is called once per distinct unmatched name, even if repeated in the text", () => {
  const unmatched = [];
  const result = substituteInputs("$INPUTS.a $INPUTS.b $INPUTS.a", {}, (name) =>
    unmatched.push(name),
  );
  assert.equal(result, "$INPUTS.a $INPUTS.b $INPUTS.a");
  assert.deepEqual(unmatched, ["a", "b", "a"], "callback fires per occurrence; caller dedupes");
});

test("onUnmatched is called for a matched name whose value is null/undefined", () => {
  const unmatched = [];
  const result = substituteInputs("$INPUTS.a and $INPUTS.b", { a: null, b: undefined }, (name) =>
    unmatched.push(name),
  );
  assert.equal(result, "$INPUTS.a and $INPUTS.b");
  assert.deepEqual(unmatched, ["a", "b"]);
});

test("onUnmatched is never called when every token has a real matching non-null value", () => {
  const unmatched = [];
  const result = substituteInputs("$INPUTS.a and $INPUTS.b", { a: "1", b: 2 }, (name) =>
    unmatched.push(name),
  );
  assert.equal(result, "1 and 2");
  assert.deepEqual(unmatched, []);
});

test("onUnmatched is not required (omitting it behaves exactly as before)", () => {
  assert.equal(substituteInputs("cc $INPUTS.missing", { topic: "x" }), "cc $INPUTS.missing");
});
