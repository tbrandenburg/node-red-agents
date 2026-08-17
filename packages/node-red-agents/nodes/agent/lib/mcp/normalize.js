'use strict';

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
        if (!server || typeof server.name !== 'string' || !server.name.trim()) continue;

        if (server.type === 'remote') {
            if (typeof server.url !== 'string' || !server.url.trim()) continue;
            out[server.name] = { type: 'remote', url: server.url, enabled: true };
        } else if (server.type === 'local') {
            if (typeof server.command !== 'string' || !server.command.trim()) continue;
            const args = Array.isArray(server.args) ? server.args : [];
            out[server.name] = { type: 'local', command: [server.command, ...args], enabled: true };
        }
        // Unknown types are silently skipped -- validate() at the adapter
        // level is responsible for surfacing a clear error before execution.
    }

    return out;
}

module.exports = { toOpenCodeMcp };
