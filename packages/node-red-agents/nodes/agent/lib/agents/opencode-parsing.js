"use strict";

// Only these fields from V2 Session.StructuredError are public diagnostics.
// The lifecycle redactor sanitizes message/type using the selected auth's secrets.
function parseV2Error(error) {
  const type = error.type;
  const message =
    typeof error.message === "string" && error.message.trim()
      ? error.message
      : "opencode reported an error";
  const status =
    Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
      ? error.status
      : undefined;
  const labels = {
    "provider.auth": "authentication failed",
    "provider.quota": "credit exhaustion",
    "permission.rejected": "permission denied",
    "provider.rate-limit": "rate limit",
    "provider.transport": "network error",
    "provider.internal": "overloaded",
  };
  const label = Object.prototype.hasOwnProperty.call(labels, type) ? labels[type] : type;
  const fatal =
    [
      "provider.auth",
      "provider.quota",
      "permission.rejected",
      "aborted",
      "provider.content-filter",
      "provider.invalid-request",
      "provider.unsupported-operation",
      "provider.no-route",
    ].includes(type) || [401, 402, 403].includes(status);
  return {
    errorMessage: `${message} (${type}${label !== type ? `; ${label}` : ""}${status ? `; HTTP ${status}` : ""})`,
    errorDetail: { type, message, ...(status ? { status } : {}) },
    ...(fatal ? { retryable: false } : {}),
  };
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

// V2 output is visible output (reasoning excluded); V1 output includes reasoning.
// Both input fields exclude cache reads/writes. Prefer an explicit reported total.
function summarizeUsage(raw, version) {
  let costUsd;
  let tokens;
  for (const event of raw) {
    if (event.type !== "step_finish" || !event.part || typeof event.part !== "object") continue;
    const part = event.part;
    if (typeof part.cost === "number" && Number.isFinite(part.cost)) {
      costUsd = (costUsd || 0) + part.cost;
    }
    if (!part.tokens || typeof part.tokens !== "object") continue;
    const input = count(part.tokens.input);
    const output = count(part.tokens.output);
    const reasoning = count(part.tokens.reasoning);
    const read = count(part.tokens.cache?.read);
    const write = count(part.tokens.cache?.write);
    const total =
      typeof part.tokens.total === "number" &&
      Number.isFinite(part.tokens.total) &&
      part.tokens.total >= 0
        ? part.tokens.total
        : input + output + read + write + (version === 2 ? reasoning : 0);
    tokens = tokens || {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };
    tokens.total += total;
    tokens.input += input;
    tokens.output += output;
    tokens.reasoning += reasoning;
    tokens.cache.read += read;
    tokens.cache.write += write;
  }
  return {
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

module.exports = { parseV2Error, summarizeUsage };
