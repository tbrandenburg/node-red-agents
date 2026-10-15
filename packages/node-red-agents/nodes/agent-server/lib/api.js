"use strict";

const { request } = require("./http");
const { completedTurn } = require("./turn");
const { parseModel } = require("./model");

function data(body) {
  return body && Object.prototype.hasOwnProperty.call(body, "data") ? body.data : body;
}

function apiRequest(baseUrl, path, opts = {}) {
  return request(`${baseUrl}/api${path}`, { ...opts, redactErrors: true }).then(data);
}

function health(baseUrl, opts) {
  return apiRequest(baseUrl, "/info", opts).then((result) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("v2 health endpoint returned an unexpected response");
    }
    return result;
  });
}

function createSession(baseUrl, title, opts) {
  return apiRequest(baseUrl, "/session", { ...opts, method: "POST", body: { title } });
}

function prompt(baseUrl, sessionID, text, opts = {}) {
  const body = { text: String(text) };
  if (opts.promptID !== undefined) body.id = opts.promptID;
  return apiRequest(baseUrl, `/session/${encodeURIComponent(sessionID)}/prompt`, {
    ...opts,
    method: "POST",
    body,
  });
}

function switchAgent(baseUrl, sessionID, agent, opts) {
  return apiRequest(baseUrl, `/session/${encodeURIComponent(sessionID)}/agent`, {
    ...opts,
    method: "POST",
    body: { agent },
  });
}

function switchModel(baseUrl, sessionID, model, opts) {
  const reference = parseModel(`${model.providerID}/${model.modelID}`, 2, model.variant);
  return apiRequest(baseUrl, `/session/${encodeURIComponent(sessionID)}/model`, {
    ...opts,
    method: "POST",
    body: {
      model: {
        providerID: reference.providerID,
        id: reference.modelID,
        ...(reference.variant ? { variant: reference.variant } : {}),
      },
    },
  });
}

async function messages(baseUrl, sessionID, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000;
  const deadline = Date.now() + timeoutMs;
  const history = [];
  const seen = new Set();
  const cursors = new Set();
  let cursor;
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`v2 history did not complete within ${timeoutMs}ms`);
    // Preserve the envelope: unwrapping data here would discard pagination.
    const page = await request(
      `${baseUrl}/api/session/${encodeURIComponent(sessionID)}/message${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      { ...opts, timeoutMs: remaining, redactErrors: true },
    );
    const entries = data(page);
    if (!Array.isArray(entries)) {
      throw new Error("v2 messages endpoint returned an unexpected response");
    }
    for (const entry of entries) {
      if (entry?.id && seen.has(entry.id)) continue;
      history.push(entry);
      if (entry?.id) seen.add(entry.id);
    }
    // Empty terminal pages can follow a non-null cursor in v2.0.28.
    if (!entries.length || (opts.untilMessageID && seen.has(opts.untilMessageID))) return history;
    cursor = page?.cursor?.next;
    if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
      throw new Error("v2 messages endpoint returned an invalid cursor");
    }
    if (cursor && cursors.has(cursor)) throw new Error("v2 history pagination cursor repeated");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return history;
}

function assertMessageSuccess(response) {
  const error = response?.info?.error || response?.error;
  if (!error) return;
  const type = error.name || error.type;
  const status = error.data?.statusCode ?? error.status;
  // Only fixed labels leave the daemon: provider messages, bodies and headers can contain secrets.
  const labels = {
    ProviderAuthError: "ProviderAuthError: provider authentication failed",
    APIError:
      status === 401 || status === 403
        ? "APIError: provider authentication failed"
        : "APIError: provider request failed",
    MessageAbortedError: "MessageAbortedError: message aborted",
    MessageOutputLengthError: "MessageOutputLengthError: output length exceeded",
    ContextOverflowError: "ContextOverflowError: context limit exceeded",
    StructuredOutputError: "StructuredOutputError: structured output failed",
    UnknownError: "UnknownError: assistant generation failed",
  };
  throw new Error(
    Object.prototype.hasOwnProperty.call(labels, type)
      ? labels[type]
      : status === 401 || status === 403
        ? "provider authentication failed"
        : "assistant generation failed",
  );
}

async function waitForIdle(baseUrl, sessionID, afterMessageID, opts = {}) {
  if (typeof afterMessageID !== "string" || !afterMessageID) {
    throw new Error("v2 prompt admission returned an unexpected message ID");
  }
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    let result;
    try {
      result = await messages(baseUrl, sessionID, {
        ...opts,
        untilMessageID: afterMessageID,
        timeoutMs: Math.max(1, Math.min(opts.timeoutMs, deadline - Date.now())),
      });
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(`v2 prompt did not complete within ${opts.timeoutMs}ms`, { cause: err });
      }
      throw err;
    }
    if (!Array.isArray(result))
      throw new Error("v2 messages endpoint returned an unexpected response");
    const turn = completedTurn(result, afterMessageID);
    if (turn) return turn;
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(1, remaining))));
    // A deadline timer can wake a millisecond early; don't start another request
    // when the next polling interval would have consumed the remaining budget.
    if (remaining <= 200) break;
  }
  throw new Error(`v2 prompt did not complete within ${opts.timeoutMs}ms`);
}

async function waitForCompletion(baseUrl, sessionID, afterMessageID, opts = {}) {
  const turn = await waitForIdle(baseUrl, sessionID, afterMessageID, opts);
  if (turn.idle.outcome === "interrupted") {
    throw new Error("MessageAbortedError: message aborted");
  }
  assertMessageSuccess(turn.idle);
  if (turn.idle.outcome === "failed") throw new Error("v2 prompt execution failed");
  if (turn.idle.outcome !== "succeeded") {
    throw new Error("v2 idle message returned an unexpected outcome");
  }
  assertMessageSuccess(turn.assistant);
  if (!turn.assistant || !turn.assistant.time?.completed) {
    throw new Error("v2 successful turn has no completed assistant message");
  }
  return turn.assistant;
}

function abort(baseUrl, sessionID, opts) {
  return apiRequest(baseUrl, `/session/${encodeURIComponent(sessionID)}/interrupt`, {
    ...opts,
    method: "POST",
  });
}

module.exports = {
  data,
  health,
  createSession,
  prompt,
  switchAgent,
  switchModel,
  messages,
  assertMessageSuccess,
  waitForCompletion,
  waitForIdle,
  abort,
};
