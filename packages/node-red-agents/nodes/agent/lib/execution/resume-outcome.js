"use strict";

// Computes the three-state "was a requested resume actually honored?"
// signal, mirroring Archon's shared/resumed.ts:
//   undefined -- no resume was requested this invocation (fresh by design,
//                or this adapter doesn't support resume at all)
//   true      -- resume was requested and the adapter/CLI honored it
//   false     -- resume was requested but did not happen (may co-occur
//                with a failed execution -- see opencode.js's CAPABILITIES
//                comment for the verified OpenCode-specific behavior)
//
// `requestedSessionID` is the sessionID this execution was originally
// invoked with (item.resolved.sessionID, before any internal retry/reask
// continuity mutation); `actualSessionID` is the FINAL result.sessionID
// reported by the adapter's parseResult() once the whole execution
// (including any internal retries/reasks) has settled.
function resumeOutcome(requestedSessionID, actualSessionID, sessionResumeCapable) {
  if (!requestedSessionID || !sessionResumeCapable) return undefined;
  return requestedSessionID === actualSessionID;
}

module.exports = { resumeOutcome };
