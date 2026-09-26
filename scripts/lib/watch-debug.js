"use strict";

// Subscribes to a running Node-RED instance's /comms WebSocket, fires an
// inject node via the admin HTTP API, and resolves as soon as either the
// target debug node emits a message or any node reports a red ("error")
// status -- reacting the instant the result arrives instead of a fixed
// sleep+poll. Extracted from scripts/run-and-watch.js (see that file for
// the CLI wrapper) so both the interactive CLI and the automated smoke/E2E
// suite (test/integration/) share exactly one implementation of this
// round-trip logic, per docs/260817_Refactoring.md step 15.
//
// Requires Node 22+ (uses the built-in global fetch/WebSocket).
//
// Returns a Promise resolving to { ok: true, data } on a matching debug
// message, or { ok: false, reason: 'timeout' | 'red-status', data? } on
// timeout or an error status -- never rejects, so callers don't need a
// try/catch just to distinguish "no result" from a real thrown error.
function waitForDebug({ baseUrl, injectId, debugId, errorDebugId, maxWaitMs = 60000 }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, "ws") + "/comms");
    let settled = false;
    let lastStatus;
    const recentDebugs = [];

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(result);
    }

    const timer = setTimeout(
      () => finish({ ok: false, reason: "timeout", lastStatus, recentDebugs }),
      maxWaitMs,
    );

    ws.addEventListener("open", async () => {
      ws.send(JSON.stringify({ subscribe: "debug" }));
      ws.send(JSON.stringify({ subscribe: "status/#" }));
      // Give the subscribe a moment to land server-side before firing
      // the inject, so we don't race and miss the first message.
      await new Promise((r) => setTimeout(r, 300));
      const res = await fetch(baseUrl + "/inject/" + injectId, { method: "POST" });
      if (process.env.WATCH_DEBUG_QUIET !== "1") {
        console.error("[watch] injected", injectId, "->", res.status);
      }
    });

    ws.addEventListener("message", (ev) => {
      let events;
      try {
        events = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      for (const e of events) {
        if (e.topic && e.topic.startsWith("status/")) lastStatus = { topic: e.topic, data: e.data };
        if (e.topic === "debug" && e.data && typeof e.data.id === "string") {
          let debugMessage;
          try {
            debugMessage = typeof e.data.msg === "string" ? JSON.parse(e.data.msg) : e.data.msg;
          } catch (_err) {
            debugMessage = undefined;
          }
          recentDebugs.push({
            id: e.data.id,
            messageType: typeof debugMessage,
            messageKeys:
              debugMessage && typeof debugMessage === "object"
                ? Object.keys(debugMessage).slice(0, 12)
                : undefined,
            operation: debugMessage && debugMessage.operation,
            payloadValueType: debugMessage && typeof debugMessage.payload,
            payloadType: debugMessage && debugMessage.payload && debugMessage.payload.type,
          });
          if (recentDebugs.length > 20) recentDebugs.shift();
        }
        if (e.topic === "debug" && e.data && e.data.id === debugId) {
          finish({ ok: true, data: e.data });
        }
        if (errorDebugId && e.topic === "debug" && e.data && e.data.id === errorDebugId) {
          finish({ ok: false, reason: "node-error", data: e.data });
        }
        if (
          !errorDebugId &&
          e.topic &&
          e.topic.startsWith("status/") &&
          e.data &&
          e.data.fill === "red"
        ) {
          finish({ ok: false, reason: "red-status", topic: e.topic, data: e.data });
        }
      }
    });

    ws.addEventListener("error", (ev) => {
      finish({ ok: false, reason: "ws-error", data: ev.message || ev });
    });
  });
}

module.exports = { waitForDebug };
