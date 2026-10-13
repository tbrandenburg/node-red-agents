"use strict";

const blocked =
  /^(?:api[-_]?key|authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|headers|request|body|rawResponse|responseBody|cause|stack|token|secret|password)$/i;

function sanitize(value, secrets = [], depth = 0, metadata = true) {
  if (depth > 20) return "[redacted]";
  if (typeof value === "string") {
    const redacted = secrets
      .filter(Boolean)
      .flatMap((secret) => [secret, encodeURIComponent(secret)])
      .reduce((text, secret) => text.split(secret).join("[redacted]"), value);
    return redacted.replace(/\bBearer\s+[^\s,;"'}]+/gi, "Bearer [redacted]");
  }
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value))
    return value.map((entry) => sanitize(entry, secrets, depth + 1, metadata));
  if (typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !metadata || !blocked.test(key))
      .map(([key, entry]) => [
        sanitize(key, secrets),
        sanitize(entry, secrets, depth + 1, metadata),
      ]),
  );
}

function sanitizeResult(result, secrets = []) {
  const fields = [
    "text",
    "object",
    "output",
    "answers",
    "rounding",
    "embedding",
    "embeddings",
    "usage",
    "totalUsage",
    "finishReason",
    "warnings",
    "providerMetadata",
    "response",
  ];
  // Payload keys belong to the application, not the transport metadata vocabulary.
  return Object.fromEntries(
    fields
      .filter((key) => result?.[key] !== undefined)
      .map((key) => [
        key,
        sanitize(result[key], secrets, 1, !["object", "output", "answers"].includes(key)),
      ]),
  );
}

function safeError(error) {
  const local = {
    INVALID_PROVIDER_CONFIG: "Invalid model provider configuration",
    MISSING_PROVIDER_CONFIG: "Select a model-provider config node",
    MISSING_PROVIDER_CREDENTIAL: "Model provider API key is missing",
    REQUEST_TIMEOUT: "Model provider request timed out",
    REQUEST_ABORTED: "Model provider request aborted",
  };
  const code = Object.hasOwn(local, error?.code) ? error.code : undefined;
  const statuses = [];
  for (let current = error, depth = 0; current && depth < 6; current = current.cause, depth++) {
    if (Number.isInteger(current.statusCode)) statuses.push(current.statusCode);
  }
  const status = statuses.find((value) => value >= 400 && value <= 599);
  const message = code
    ? local[code]
    : status === 401 || status === 403
      ? "Model provider authentication failed"
      : status === 429
        ? "Model provider rate limit exceeded"
        : "Model provider request failed";
  const clean = new Error(message);
  clean.name = "ModelProviderError";
  clean.code =
    code ||
    (status === 401 || status === 403
      ? "PROVIDER_AUTH"
      : status === 429
        ? "PROVIDER_RATE_LIMIT"
        : "PROVIDER_ERROR");
  if (status) clean.statusCode = status;
  return clean;
}

async function runRequest(callback, { timeout, signal, secrets = [] }) {
  const controller = new AbortController();
  const aborted = (code) => Object.assign(new Error(code), { code });
  const abort = () => controller.abort(aborted("REQUEST_ABORTED"));
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(aborted("REQUEST_TIMEOUT")), timeout);
  let listener;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const cancelled = new Promise((_, reject) => {
      listener = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", listener, { once: true });
    });
    const result = await Promise.race([
      Promise.resolve().then(() => callback({ abortSignal: controller.signal, maxRetries: 0 })),
      cancelled,
    ]);
    return sanitizeResult(result, secrets);
  } catch (error) {
    throw safeError(controller.signal.aborted ? controller.signal.reason : error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (listener) controller.signal.removeEventListener("abort", listener);
  }
}

module.exports = { sanitizeResult, safeError, runRequest };
