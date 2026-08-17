"use strict";

// Splits a string of gh CLI arguments into an argv array without any shell
// evaluation. Single- and double-quoted spans are kept as one argument
// (quotes themselves are stripped); everything else -- including shell
// metacharacters like &&, |, ;, `, $() -- is passed through as literal
// characters, never interpreted.
//
// Examples:
//   'list --state open'                  -> ['list', '--state', 'open']
//   'list --label "needs review"'        -> ['list', '--label', 'needs review']
//   'pr list && rm -rf /'                -> ['pr', 'list', '&&', 'rm', '-rf', '/']
function parseArgs(str) {
  if (str === undefined || str === null) return [];
  if (typeof str !== "string") {
    throw new Error("parseArgs: expected a string, got " + typeof str);
  }

  const args = [];
  let current = "";
  let inArg = false;
  let quote = null; // '"' or "'" while inside a quoted span

  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      inArg = true;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (inArg) {
        args.push(current);
        current = "";
        inArg = false;
      }
      continue;
    }

    current += ch;
    inArg = true;
  }

  if (quote) {
    // Unterminated quote: fail safe by treating the rest of the
    // string as literal content rather than throwing, since this is
    // config text a user can fix, not something to crash a flow over.
    args.push(current);
  } else if (inArg) {
    args.push(current);
  }

  return args;
}

module.exports = { parseArgs };
