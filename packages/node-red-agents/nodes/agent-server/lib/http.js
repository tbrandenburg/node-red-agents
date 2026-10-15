"use strict";

// Thin fetch wrapper for talking to an opencode `serve` daemon: adds an
// AbortController-based timeout (fetch has no built-in one) and optional
// HTTP basic auth. Deliberately not a generic HTTP client -- just enough to
// call the handful of endpoints this node needs.
function basicAuthHeader(username, password) {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

function requestError(url, opts, error, aborted, timeoutMs) {
  if (aborted) {
    const message = `request to ${url} timed out after ${timeoutMs}ms`;
    return opts.redactErrors ? new Error(message) : new Error(message, { cause: error });
  }
  if (error.status) return error;
  if (opts.redactErrors) return new Error(`request to ${url} failed`);
  return new Error(`request to ${url} failed: ${error.message}`, { cause: error });
}

// opts: { method, body, timeoutMs, username, password }
// Returns the parsed JSON body, or undefined for a 204/empty response.
// Throws an Error (with .status set, if the server responded at all) on
// network failure, timeout, or a non-2xx response.
async function request(url, opts = {}) {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || 30000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = { "Content-Type": "application/json" };
  if (opts.username || opts.password) {
    headers.Authorization = basicAuthHeader(opts.username || "", opts.password || "");
  }

  try {
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    // Keep the same deadline active while consuming a delayed or stalled body.
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch (_err) {
      body = text;
    }
    if (!res.ok) {
      const error = new Error(
        `${opts.method || "GET"} ${url} -> ${res.status}${!opts.redactErrors && text ? ": " + text : ""}`,
      );
      error.status = res.status;
      if (!opts.redactErrors) error.body = body;
      throw error;
    }
    return body;
  } catch (err) {
    throw requestError(url, opts, err, controller.signal.aborted, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { request, basicAuthHeader };
