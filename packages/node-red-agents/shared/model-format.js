"use strict";

// opencode's model identifiers are always "provider/model" (e.g.
// "github-copilot/claude-sonnet-5"). Both the `agent` node (which passes
// the string straight through to `opencode run --model`) and the
// `agent-server` node (which splits it into { providerID, modelID } for the
// HTTP API, see agent-server/lib/model.js) need the same shape check.
//
// This exists because a malformed or non-existent model string currently
// only surfaces as opencode's own generic, unhelpful failure -- e.g.
// `opencode run --model bogus "hi"` prints
//   {"type":"error","error":{"name":"UnknownError","data":{"message":
//   "Unexpected server error. Check server logs for details.","ref":"err_..."}}}
// with exit code 0, and that "err_..." ref does *not* actually appear in
// opencode's own log file (verified empirically) -- so "check server logs"
// is a dead end. Catching an obviously-malformed string (no slash, or an
// empty provider/model half) before ever spawning opencode turns that into
// an immediate, actionable Node-RED error instead. It cannot catch a
// syntactically valid but non-existent "provider/model" pair -- that still
// requires either `opencode models` (see opencode's own --help) or opencode
// fixing its own error reporting.
function assertModelFormat(value) {
  if (value === undefined || value === null || value === "") return;
  const str = String(value);
  const slash = str.indexOf("/");
  if (slash <= 0 || slash === str.length - 1) {
    throw new Error(
      `invalid model "${str}" -- expected "provider/model" (e.g. "github-copilot/claude-sonnet-5"); ` +
        `run "opencode models" to list valid values`,
    );
  }
}

module.exports = { assertModelFormat };
