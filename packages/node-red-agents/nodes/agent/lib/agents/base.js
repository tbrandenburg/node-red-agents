"use strict";

// Generic interface every agent harness adapter (OpenCode, and later
// Pi/Claude Code) must implement. The Agent node core only ever talks to
// this interface -- it must never know about a specific agent's CLI flags.
class AgentAdapter {
  // Throws a descriptive Error if `resolved` (the already-typed-input
  // -resolved config, see lib/execution/lifecycle.js) is not runnable.
  // Must not have side effects beyond validation.
  //
  // `resolved.sessionID` (string, may be '' or undefined) is an optional
  // continuation id: '' / undefined means "start a new session" (today's
  // only behavior); a non-empty value asks the adapter to resume that
  // session instead. An adapter that has no way to honor this (no
  // underlying CLI/session concept, or one that's deliberately disabled
  // -- see the Pi adapter) must throw here rather than silently ignoring
  // it or starting a new session anyway.
  validate(_resolved) {}

  // Returns { command, args, env } -- a normalized, adapter-specific
  // execution request. `args` must always be a plain array of strings;
  // never a shell command string (see spec: spawn over exec).
  buildExecution(_resolved) {
    throw new Error("AgentAdapter.buildExecution() not implemented");
  }

  // Parses one line of stdout. Returns a normalized event object
  // { type, sessionID, data } or null if the line should be ignored
  // (blank, or malformed -- must never throw).
  parseEvent(_line) {
    return null;
  }

  // Given all accumulated parsed events plus the process exit info,
  // returns { payload, sessionID, status, errorMessage? }.
  // status is one of "completed" | "failed".
  parseResult(_events, _exitCode, _signal, _stderr) {
    return { payload: "", status: "completed" };
  }
}

module.exports = { AgentAdapter };
