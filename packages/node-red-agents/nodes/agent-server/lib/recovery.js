"use strict";

const api = require("./api");

// Admission may have committed even when its response was lost. Interrupting
// alone is insufficient: require this caller's anchor and durable terminal.
async function settleTurn(baseUrl, sessionID, promptID, opts) {
  const deadline = Date.now() + Math.min(opts.timeoutMs, 5000);
  const options = () => ({ ...opts, timeoutMs: Math.max(1, deadline - Date.now()) });
  try {
    await api.abort(baseUrl, sessionID, options());
    if (Date.now() >= deadline) return false;
    const turn = await api.waitForIdle(baseUrl, sessionID, promptID, options());
    return ["succeeded", "failed", "interrupted"].includes(turn.idle.outcome);
  } catch (_error) {
    // The owner must destroy its private daemon if settlement cannot be proved.
    return false;
  }
}

module.exports = { settleTurn };
