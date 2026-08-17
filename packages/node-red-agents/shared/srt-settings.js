"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Translates the simple "Inline" SRT settings UI (two string lists + one
// checkbox), used by both the `agent` and `agent-server` nodes, into the
// JSON shape `srt` itself requires, and writes it to a temp file (srt only
// accepts a file path via -s, not inline JSON). Kept separate from
// lib/runtimes/srt.js (agent) and lib/daemon.js (agent-server), which stay
// completely runtime-source-agnostic -- they only ever see a settingsPath
// string and don't care whether it came from this module or a hand-authored
// file (spec: "SRT-specific configuration... implemented by the runtime
// adapter rather than embedded in the Agent node core").
//
// Shared here (not duplicated) because both consumers now live in the same
// publishable package (packages/node-red-agents) -- see docs/260817_Refactoring.md
// step 8. Previously this was a verbatim copy in each node's lib/, kept
// separate only because each node used to be its own standalone npm package.
//
// srt requires network.allowedDomains, network.deniedDomains,
// filesystem.denyRead, and filesystem.denyWrite to all be *present* (even
// as empty arrays) -- verified empirically: srt refuses to run and prints
// "<field>: Required" for each one missing. This function always includes
// all four.
function buildSettingsJson({ allowedDomains, allowedWriteDirs, strictAllowlist } = {}) {
  return {
    network: {
      allowedDomains: Array.isArray(allowedDomains) ? allowedDomains : [],
      deniedDomains: [],
      strictAllowlist: strictAllowlist !== false,
    },
    filesystem: {
      allowWrite: Array.isArray(allowedWriteDirs) ? allowedWriteDirs : [],
      denyRead: [],
      denyWrite: [],
    },
  };
}

// config: { allowedDomains, allowedWriteDirs, strictAllowlist, advancedJson }
// Returns the JSON string that will be written (and validated as parseable
// JSON) -- does not touch the filesystem. Kept separate from
// writeInlineSettingsFile so tests can check the generated content without
// needing a real filesystem.
function resolveSettingsJsonString(config = {}) {
  const raw =
    config.advancedJson && config.advancedJson.trim()
      ? config.advancedJson
      : JSON.stringify(buildSettingsJson(config));
  // Throws a clear SyntaxError if the (usually hand-edited advanced) JSON
  // is invalid -- deliberately no deeper validation than "is this valid
  // JSON"; srt's own runtime error for a structurally-wrong-but-valid-JSON
  // settings file is already clear and surfaces through the normal
  // execution/spawn-failure path.
  JSON.parse(raw);
  return raw;
}

// nodeId is used only to make the temp filename recognizable/stable per
// node instance; process.pid is appended so a fast redeploy sequence can
// never have two live Node-RED processes racing on the same file.
// filePrefix distinguishes callers (e.g. 'agent' vs 'agent-server') so two
// different node types configuring the same nodeId-shaped id can never
// collide on the same temp file.
function writeInlineSettingsFile(nodeId, config, filePrefix = "srt-settings") {
  const json = resolveSettingsJsonString(config);
  const filePath = path.join(os.tmpdir(), `${filePrefix}-${nodeId}-${process.pid}.json`);
  fs.writeFileSync(filePath, json);
  return filePath;
}

module.exports = { buildSettingsJson, resolveSettingsJsonString, writeInlineSettingsFile };
