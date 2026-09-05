"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classifyError, shouldRetry } = require("../../lib/execution/retry");

test("classifyError: FATAL patterns", () => {
  assert.equal(classifyError("401 Unauthorized"), "FATAL");
  assert.equal(classifyError("Forbidden: access denied"), "FATAL");
  assert.equal(classifyError("invalid token supplied"), "FATAL");
  assert.equal(classifyError("Authentication failed"), "FATAL");
  assert.equal(classifyError("permission denied"), "FATAL");
  assert.equal(classifyError("403"), "FATAL");
  assert.equal(classifyError("credit exhaustion"), "FATAL");
  assert.equal(classifyError("credit balance too low"), "FATAL");
});

test("classifyError: TRANSIENT patterns", () => {
  assert.equal(classifyError("request timeout"), "TRANSIENT");
  assert.equal(classifyError("ECONNREFUSED"), "TRANSIENT");
  assert.equal(classifyError("read ECONNRESET"), "TRANSIENT");
  assert.equal(classifyError("ETIMEDOUT"), "TRANSIENT");
  assert.equal(classifyError("503 Service Unavailable"), "TRANSIENT");
  assert.equal(classifyError("502 Bad Gateway"), "TRANSIENT");
  assert.equal(classifyError("429 Too Many Requests"), "TRANSIENT");
  assert.equal(classifyError("rate limit exceeded"), "TRANSIENT");
  assert.equal(classifyError("server overloaded"), "TRANSIENT");
  assert.equal(classifyError("network error occurred"), "TRANSIENT");
  assert.equal(classifyError("socket hang up"), "TRANSIENT");
  assert.equal(classifyError("exited with code 1"), "TRANSIENT");
});

test("classifyError: FATAL wins over TRANSIENT when both match", () => {
  assert.equal(classifyError("401 Unauthorized: network error while authenticating"), "FATAL");
});

test("classifyError: unknown message falls back to UNKNOWN", () => {
  assert.equal(classifyError("something completely unexpected happened"), "UNKNOWN");
  assert.equal(classifyError(undefined), "UNKNOWN");
  assert.equal(classifyError(""), "UNKNOWN");
});

test("shouldRetry: retryable:false always wins, regardless of onError", () => {
  const result = { errorMessage: "ETIMEDOUT", retryable: false };
  assert.equal(shouldRetry(result, "transient"), false);
  assert.equal(shouldRetry(result, "all"), false);
});

test("shouldRetry: onError 'transient' only retries TRANSIENT-classified errors", () => {
  assert.equal(shouldRetry({ errorMessage: "ETIMEDOUT" }, "transient"), true);
  assert.equal(shouldRetry({ errorMessage: "something odd" }, "transient"), false);
  assert.equal(shouldRetry({ errorMessage: "401 Unauthorized" }, "transient"), false);
});

test("shouldRetry: onError 'all' retries any non-fatal error", () => {
  assert.equal(shouldRetry({ errorMessage: "ETIMEDOUT" }, "all"), true);
  assert.equal(shouldRetry({ errorMessage: "something odd" }, "all"), true);
  assert.equal(shouldRetry({ errorMessage: "401 Unauthorized" }, "all"), false);
});
