'use strict';

const fs = require('fs');
const { AgentAdapter } = require('./base');
const { toOpenCodeMcp } = require('../mcp/normalize');

// Maps opencode's real `--format json` event stream types (verified against
// packages/opencode/src/cli/cmd/run.ts) onto the Agent node's generic event
// vocabulary (spec section "Event output").
const TYPE_MAP = {
    step_start: 'started',
    step_finish: 'progress',
    tool_use: 'tool',
    text: 'agent',
    reasoning: 'agent',
    error: 'failed'
};

class OpenCodeAdapter extends AgentAdapter {
    validate(resolved) {
        if (resolved.cwd) {
            let stat;
            try {
                stat = fs.statSync(resolved.cwd);
            } catch (err) {
                throw new Error(`cwd does not exist: ${resolved.cwd}`);
            }
            if (!stat.isDirectory()) {
                throw new Error(`cwd is not a directory: ${resolved.cwd}`);
            }
        }

        if (resolved.invocation === 'prompt') {
            if (!resolved.prompt || !String(resolved.prompt).trim()) {
                throw new Error('prompt invocation requires a non-empty prompt (msg.payload or the Prompt field)');
            }
        } else if (resolved.invocation === 'skill' || resolved.invocation === 'command') {
            if (!resolved.invocationName || !String(resolved.invocationName).trim()) {
                throw new Error(`${resolved.invocation} invocation requires a non-empty name`);
            }
        } else {
            throw new Error(`unknown invocation mode: ${resolved.invocation}`);
        }

        for (const server of resolved.mcpServers || []) {
            if (!server || !server.name) {
                throw new Error('mcpServers entries require a name');
            }
            if (server.type === 'remote' && !server.url) {
                throw new Error(`mcp server "${server.name}" (remote) requires a url`);
            }
            if (server.type === 'local' && !server.command) {
                throw new Error(`mcp server "${server.name}" (local) requires a command`);
            }
            if (server.type !== 'remote' && server.type !== 'local') {
                throw new Error(`mcp server "${server.name}" has unknown type: ${server.type}`);
            }
        }
    }

    buildExecution(resolved) {
        const args = ['run', '--format', 'json'];

        // Resuming an existing session (opencode run -s <id> ...) rather
        // than always starting a new one -- verified against `opencode run
        // --help`: -s/--session takes the id to continue.
        if (resolved.sessionID) args.push('--session', String(resolved.sessionID));

        if (resolved.cwd) args.push('--dir', resolved.cwd);
        if (resolved.model) args.push('--model', resolved.model);
        if (resolved.auto) args.push('--auto');

        // Skill and Command/Template invocation share the same underlying
        // opencode mechanism: skills are registered internally as commands
        // (source:"skill"), so `--command <name>` handles both -- verified
        // against packages/opencode/src/command/index.ts.
        if (resolved.invocation === 'skill' || resolved.invocation === 'command') {
            args.push('--command', String(resolved.invocationName));
            args.push(resolved.args !== undefined && resolved.args !== null ? String(resolved.args) : '');
        } else {
            args.push(String(resolved.prompt));
        }

        const env = {};
        if (Array.isArray(resolved.mcpServers) && resolved.mcpServers.length > 0) {
            env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp: toOpenCodeMcp(resolved.mcpServers) });
        }

        return { command: 'opencode', args, env };
    }

    parseEvent(line) {
        const trimmed = line.trim();
        if (!trimmed) return null;

        let raw;
        try {
            raw = JSON.parse(trimmed);
        } catch (err) {
            // Malformed/non-JSON diagnostic output must never crash Node-RED.
            return null;
        }

        const type = TYPE_MAP[raw.type] || raw.type || 'progress';
        return { type, sessionID: raw.sessionID, data: raw };
    }

    parseResult(events, exitCode, signal, stderr) {
        const raw = events.map((e) => e.data);
        const errorEvent = raw.find((e) => e.type === 'error');
        const sessionID = raw.length ? raw[raw.length - 1].sessionID : undefined;

        const payload = raw
            .filter((e) => e.type === 'text' && e.part && typeof e.part.text === 'string')
            .map((e) => e.part.text)
            .join('\n')
            .trim();

        if (errorEvent) {
            const message =
                (errorEvent.error &&
                    ((errorEvent.error.data && errorEvent.error.data.message) || errorEvent.error.name)) ||
                'opencode reported an error';
            return { payload, sessionID, status: 'failed', errorMessage: message };
        }
        if (signal) {
            return { payload, sessionID, status: 'failed', errorMessage: `process killed by signal ${signal}` };
        }
        if (exitCode !== 0) {
            return {
                payload,
                sessionID,
                status: 'failed',
                errorMessage: `exited with code ${exitCode}${stderr ? ': ' + String(stderr).trim() : ''}`
            };
        }
        return { payload, sessionID, status: 'completed' };
    }
}

module.exports = { OpenCodeAdapter };
