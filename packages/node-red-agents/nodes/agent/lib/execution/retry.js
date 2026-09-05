"use strict";

// Node-level retry classification (issue #24). Deliberately tiny and
// framework-agnostic (no Node-RED dependency) so it can be unit-tested in
// isolation -- see test/execution/retry.spec.js. Consumed by agent.js's
// startExecution retry loop, which owns the actual delay/re-invoke wiring
// (this module only ever classifies/decides, never sleeps or retries
// anything itself).

// FATAL patterns are checked first and win over TRANSIENT when both match
// (e.g. a 401 body that also happens to mention a network-ish word) --
// per the issue spec, an auth/permission failure should never be retried
// just because its text also contains a transient-looking substring.
const FATAL_PATTERNS = [
  "unauthorized",
  "forbidden",
  "invalid token",
  "authentication failed",
  "permission denied",
  "401",
  "403",
  "credit exhaustion",
  "credit balance",
];

const TRANSIENT_PATTERNS = [
  "timeout",
  "econnrefused",
  "econnreset",
  "etimedout",
  "503",
  "502",
  "429",
  "rate limit",
  "too many requests",
  "overloaded",
  "network error",
  "socket hang up",
  "exited with code",
];

function classifyError(message) {
  const text = String(message || "").toLowerCase();
  if (FATAL_PATTERNS.some((p) => text.includes(p))) return "FATAL";
  if (TRANSIENT_PATTERNS.some((p) => text.includes(p))) return "TRANSIENT";
  return "UNKNOWN";
}

// `result.retryable === false` is an explicit escape hatch (e.g. issue
// #23's structured-output validation failure, once wired) that always
// wins regardless of `onError` -- checked before any error-text
// classification.
function shouldRetry(result, onError) {
  if (result && result.retryable === false) return false;
  const classification = classifyError(result && result.errorMessage);
  if (classification === "FATAL") return false;
  if (onError === "all") return true;
  return classification === "TRANSIENT";
}

module.exports = { classifyError, shouldRetry };
