'use strict';

const fs = require('fs');
const path = require('path');
const { AgentAdapter } = require('./base');

// Maps pi's real `--mode json` event stream (verified empirically against
// pi 0.84.1 -- its own docs don't spell this out) onto the Agent node's
// generic event vocabulary. Deliberately coarser than pi's own granularity:
// text/thinking *_delta and *_start events are skipped to avoid flooding
// output 2 with one message per streamed token; only the completed chunk
// (*_end) is surfaced.
const TYPE_MAP = {
    agent_start: 'started',
    tool_execution_start: 'tool',
    tool_execution_update: 'tool',
    tool_execution_end: 'tool',
    turn_end: 'progress',
    agent_end: 'completed'
};

// pi's project-level skill/prompt-template directories, per this
// installation's ~/.pi/agent/settings.json ("skills": [".github/skills"],
// "prompts": [".github/prompts"]). Used only as a *resolution convention*
// for turning the generic Agent node's bare invocationName into a path --
// pi itself doesn't auto-discover these for a single non-interactive run
// (verified: without an explicit --skill/--prompt-template flag, the model
// has no idea the file exists and will try to go hunting for it with its
// own tools instead).
const RESOURCE_DIRS = {
    skill: '.github/skills',
    command: '.github/prompts'
};

function resolveResourcePath(name, kind, cwd) {
    const base = cwd || process.cwd();
    const candidates = [];

    if (path.isAbsolute(name)) {
        candidates.push(name);
    } else if (name.includes('/') || name.endsWith('.md')) {
        candidates.push(path.join(base, name));
    }

    const dir = RESOURCE_DIRS[kind];
    candidates.push(path.join(base, dir, name, 'SKILL.md'));
    candidates.push(path.join(base, dir, `${name}.md`));

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`could not find a ${kind} named "${name}" (looked for: ${candidates.join(', ')})`);
}

class PiAdapter extends AgentAdapter {
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
            // Throws its own clear error if nothing matches -- fail before
            // spawning anything, per the adapter contract.
            resolveResourcePath(resolved.invocationName, resolved.invocation, resolved.cwd);
        } else {
            throw new Error(`unknown invocation mode: ${resolved.invocation}`);
        }

        if (Array.isArray(resolved.mcpServers) && resolved.mcpServers.length > 0) {
            throw new Error(
                'the pi adapter does not support MCP servers (no MCP CLI/config surface was found in `pi --help`); ' +
                    'remove the configured MCP servers or switch Agent to OpenCode'
            );
        }

        if (resolved.sessionID) {
            // Every pi invocation is built with --no-session (see
            // buildExecution) -- deliberately ephemeral, matching the
            // "one CLI process = one execution" model this adapter was
            // verified against. Silently accepting a sessionID here would
            // imply continuation that never actually happens.
            throw new Error(
                'the pi adapter does not support session continuation through this node (every pi run uses ' +
                    '--no-session); leave Session ID blank or switch Agent to OpenCode'
            );
        }
    }

    buildExecution(resolved) {
        const args = ['--no-session', '--mode', 'json'];

        if (resolved.model) args.push('--model', String(resolved.model));

        // pi has no permission-prompt system to bypass in non-interactive
        // mode -- read/bash/edit/write tools just run immediately with no
        // confirmation of any kind (verified: an unrestricted run had the
        // model shell out to `find /` on its own with zero gating). The
        // closest analogue to opencode's --auto is restricting which
        // tools are even available: "not auto" -> read-only tool set,
        // "auto" -> everything. This is an approximation, not a true
        // permission bypass -- documented in the node's help text.
        if (!resolved.auto) {
            args.push('--tools', 'read,grep,find,ls');
        }

        let message;
        if (resolved.invocation === 'prompt') {
            message = String(resolved.prompt);
        } else {
            const resourcePath = resolveResourcePath(resolved.invocationName, resolved.invocation, resolved.cwd);
            const flag = resolved.invocation === 'skill' ? '--skill' : '--prompt-template';
            args.push(flag, resourcePath);

            // pi has no deterministic slash-command dispatch like
            // opencode's --command (verified: without this explicit
            // instruction the model never used the loaded skill/template
            // on its own). Spelling out the path and arguments in plain
            // language is what actually worked in testing.
            const kind = resolved.invocation === 'skill' ? 'skill' : 'prompt template';
            const argsText = resolved.args !== undefined && resolved.args !== null ? String(resolved.args) : '';
            message = `Use the "${resolved.invocationName}" ${kind} at ${resourcePath}. ${argsText}`.trim();
        }
        args.push(message);

        return { command: 'pi', args, env: {} };
    }

    parseEvent(line) {
        const trimmed = line.trim();
        if (!trimmed) return null;

        let raw;
        try {
            raw = JSON.parse(trimmed);
        } catch (err) {
            return null;
        }

        if (raw.type === 'session') {
            return { type: 'started', sessionID: raw.id, data: raw };
        }

        if (raw.type === 'message_update' && raw.assistantMessageEvent) {
            const inner = raw.assistantMessageEvent;
            if (inner.type === 'text_end' || inner.type === 'thinking_end') {
                return { type: 'agent', data: raw };
            }
            return null; // skip granular *_start/*_delta streaming noise
        }

        const type = TYPE_MAP[raw.type];
        if (!type) return null;
        return { type, data: raw };
    }

    parseResult(events, exitCode, signal, stderr) {
        const raw = events.map((e) => e.data);
        const sessionEvent = raw.find((e) => e.type === 'session');
        const sessionID = sessionEvent ? sessionEvent.id : undefined;
        const agentEnd = [...raw].reverse().find((e) => e.type === 'agent_end');

        let payload = '';
        let errorMessage;

        if (agentEnd && Array.isArray(agentEnd.messages)) {
            const lastAssistant = [...agentEnd.messages].reverse().find((m) => m.role === 'assistant');
            if (lastAssistant) {
                if (lastAssistant.stopReason === 'error') {
                    // pi does NOT set a non-zero exit code for a model/API
                    // error (verified: exit 0 with stopReason:"error" deep
                    // in the event stream) -- this is the only reliable
                    // signal, unlike opencode's {"type":"error"} + exit code.
                    errorMessage = lastAssistant.errorMessage || 'pi reported an error';
                } else if (Array.isArray(lastAssistant.content)) {
                    payload = lastAssistant.content
                        .filter((c) => c.type === 'text' && typeof c.text === 'string')
                        .map((c) => c.text)
                        .join('\n')
                        .trim();
                }
            }
        }

        if (errorMessage) {
            return { payload, sessionID, status: 'failed', errorMessage };
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
        if (!agentEnd) {
            return { payload, sessionID, status: 'failed', errorMessage: 'pi produced no agent_end event' };
        }
        return { payload, sessionID, status: 'completed' };
    }
}

module.exports = { PiAdapter, resolveResourcePath };
