"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resumeOutcome } = require("../../lib/execution/resume-outcome");

test("resumeOutcome: no sessionID requested -> undefined", () => {
  assert.equal(resumeOutcome(undefined, "ses_123", true), undefined);
  assert.equal(resumeOutcome("", "ses_123", true), undefined);
});

test("resumeOutcome: sessionID requested but capability false -> undefined", () => {
  assert.equal(resumeOutcome("ses_123", "ses_123", false), undefined);
});

test("resumeOutcome: sessionID requested, capability true, matches actual -> true", () => {
  assert.equal(resumeOutcome("ses_123", "ses_123", true), true);
});

test("resumeOutcome: sessionID requested, capability true, does not match actual -> false", () => {
  assert.equal(resumeOutcome("ses_123", "ses_999", true), false);
});

test("resumeOutcome: sessionID requested, capability true, actual undefined (failed resume) -> false", () => {
  assert.equal(resumeOutcome("ses_123", undefined, true), false);
});
