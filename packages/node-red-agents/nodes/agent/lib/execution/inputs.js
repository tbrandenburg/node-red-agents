"use strict";

// Pure string-templating helper for issue #20's $INPUTS.<name> substitution.
// Deliberately dumb: no BindingDirective/DAG concept (see issue text) --
// just a name -> value map applied to a single free-text string before it
// becomes the invocation's resolved.args, adapter-agnostic. Unmatched
// tokens are left as literal text rather than throwing, so a typo in a
// flow's arguments string degrades to visible-but-harmless output instead
// of a hard failure.
const TOKEN_RE = /\$INPUTS\.([A-Za-z0-9_]+)/g;

function substituteInputs(text, inputsMap) {
  if (typeof text !== "string" || !text) return text;
  const map = inputsMap || {};
  return text.replace(TOKEN_RE, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(map, name)) return match;
    const value = map[name];
    return value === undefined || value === null ? match : String(value);
  });
}

module.exports = { substituteInputs };
