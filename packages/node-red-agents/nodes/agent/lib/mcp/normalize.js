"use strict";

// Generic mcpServers[] (see AGENTS node schema) -> OpenCode's keyed `mcp`
// config object, as verified against opencode's real config schema:
//   { "<name>": { "type": "remote", "url": "...", "enabled": true } }
//   { "<name>": { "type": "local", "command": ["npx", "-y", "pkg"], "enabled": true } }
//
// Each agent adapter owns its own translation; this module is OpenCode's.
function toOpenCodeMcp(mcpServers) {
  const out = {};
  if (!Array.isArray(mcpServers)) return out;

  for (const server of mcpServers) {
    if (!server || typeof server.name !== "string" || !server.name.trim()) continue;

    if (server.type === "remote") {
      if (typeof server.url !== "string" || !server.url.trim()) continue;
      out[server.name] = { type: "remote", url: server.url, enabled: true };
    } else if (server.type === "local") {
      if (typeof server.command !== "string" || !server.command.trim()) continue;
      const args = Array.isArray(server.args) ? server.args : [];
      out[server.name] = { type: "local", command: [server.command, ...args], enabled: true };
    }
    // Unknown types are silently skipped -- validate() at the adapter
    // level is responsible for surfacing a clear error before execution.
  }

  return out;
}

// Generic mcpServers[] -> Copilot CLI's `--additional-mcp-config` JSON
// schema, as verified against a real `copilot --additional-mcp-config
// '{"mcpServers":{...}}' -p ... --output-format json` invocation:
//   { "mcpServers": { "<name>": { "type":"local","command":"npx",
//     "args":["-y","pkg"], "tools":["*"] } } }
// The remote shape ({"type":"remote","url":"...","tools":["*"]}) mirrors
// the local shape's structure but was not independently verified against
// a real remote MCP server -- follows `copilot mcp add`'s own default of
// `"tools":["*"]` (allow every tool from that server).
//
// KNOWN LIMITATION (do not attempt to fix here): the global
// ~/.copilot/mcp-config.json ALWAYS loads regardless of
// --additional-mcp-config -- confirmed `--disable-builtin-mcps` does NOT
// prevent this (it only suppresses actual builtin MCPs like
// github-mcp-server). Surfacing this to the user is the adapter's job
// (see copilot.js's validate()), not this pure translation function's.
function toCopilotMcp(mcpServers) {
  const out = {};
  if (!Array.isArray(mcpServers)) return { mcpServers: out };

  for (const server of mcpServers) {
    if (!server || typeof server.name !== "string" || !server.name.trim()) continue;

    if (server.type === "remote") {
      if (typeof server.url !== "string" || !server.url.trim()) continue;
      out[server.name] = { type: "remote", url: server.url, tools: ["*"] };
    } else if (server.type === "local") {
      if (typeof server.command !== "string" || !server.command.trim()) continue;
      const args = Array.isArray(server.args) ? server.args : [];
      out[server.name] = { type: "local", command: server.command, args, tools: ["*"] };
    }
    // Unknown types are silently skipped -- validate() at the adapter
    // level is responsible for surfacing a clear error before execution.
  }

  return { mcpServers: out };
}

module.exports = { toOpenCodeMcp, toCopilotMcp };
