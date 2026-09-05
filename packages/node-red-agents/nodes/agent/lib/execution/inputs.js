"use strict";

// Pure string-templating helper for issue #20's $INPUTS.<name> substitution.
// Deliberately dumb: no BindingDirective/DAG concept (see issue text) --
// just a name -> value map applied to a single free-text string before it
// becomes the invocation's resolved.args, adapter-agnostic. Unmatched
// tokens are left as literal text rather than throwing, so a typo in a
// flow's arguments string degrades to visible-but-harmless output instead
// of a hard failure.
//
// issue #29: this module has no access to the Node-RED `node` object (and
// unit tests call it directly without a fake node), so it never warns
// itself -- callers that do have a `node` may pass an optional
// onUnmatched(name) callback, invoked for every token left as literal text
// (missing from inputsMap, or present but mapped to null/undefined -- both
// produce the same visible symptom of a literal token reaching the LLM).
const TOKEN_RE = /\$INPUTS\.([A-Za-z0-9_]+)/g;

function substituteInputs(text, inputsMap, onUnmatched) {
  if (typeof text !== "string" || !text) return text;
  const map = inputsMap || {};
  return text.replace(TOKEN_RE, (match, name) => {
    const hasName = Object.prototype.hasOwnProperty.call(map, name);
    const value = hasName ? map[name] : undefined;
    if (!hasName || value === undefined || value === null) {
      if (typeof onUnmatched === "function") onUnmatched(name);
      return match;
    }
    return String(value);
  });
}

module.exports = { substituteInputs };
