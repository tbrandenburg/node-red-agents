"use strict";

const { request } = require("./http");

function data(body) {
  return body && Object.prototype.hasOwnProperty.call(body, "data") ? body.data : body;
}

function apiRequest(baseUrl, path, opts = {}) {
  return request(`${baseUrl}/api${path}`, opts).then(data);
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

function prompt(baseUrl, sessionID, text, opts) {
  const body = { text: String(text) };
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
  return apiRequest(baseUrl, `/session/${encodeURIComponent(sessionID)}/model`, {
    ...opts,
    method: "POST",
    body: { model: { providerID: model.providerID, id: model.modelID } },
  });
}

function messages(baseUrl, sessionID, opts) {
  return apiRequest(baseUrl, `/session/${encodeURIComponent(sessionID)}/message`, opts);
}

async function waitForCompletion(baseUrl, sessionID, afterMessageID, opts = {}) {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    let result;
    try {
      result = await messages(baseUrl, sessionID, {
        ...opts,
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
    const userIndex = result.findIndex((entry) => entry && entry.id === afterMessageID);
    if (userIndex > 0) {
      const assistant = result
        .slice(0, userIndex)
        .find((entry) => entry && entry.type === "assistant" && entry.time && entry.time.completed);
      if (assistant) return assistant;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now()))),
    );
  }
  throw new Error(`v2 prompt did not complete within ${opts.timeoutMs}ms`);
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
  waitForCompletion,
  abort,
};
