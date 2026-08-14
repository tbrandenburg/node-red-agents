'use strict';

const { spawn } = require('child_process');
const { parseArgs } = require('./lib/parse-args');

const GH_BINARY = 'gh';
const DEFAULT_TIMEOUT_MS = 60000;

// Resolves a typed-input style config field (str/msg/flow/global), honoring
// the Node-RED typedInput convention used elsewhere in this repo (see
// opencode-run.js's prompt/cwd handling). An empty 'str' path is treated as
// "not configured" rather than an evaluation error.
function evalField(RED, node, msg, value, type) {
    if (type === 'str' && (value === undefined || value === null || value === '')) {
        return undefined;
    }
    return RED.util.evaluateNodeProperty(value, type, node, msg);
}

// A valid gh top-level command is a single token (e.g. "pr", "issue",
// "api") -- never the literal "gh" itself and never something containing
// whitespace (which would indicate a whole command line was pasted in).
function validateCommand(command) {
    if (typeof command !== 'string' || command.trim() === '') {
        return 'no command configured (set the Command field or msg.gh.command)';
    }
    const trimmed = command.trim();
    if (/\s/.test(trimmed)) {
        return 'Command must be a single gh subcommand (e.g. "pr"), not a full command line: "' + trimmed + '"';
    }
    if (trimmed.toLowerCase() === 'gh') {
        return '"gh" is the executable itself, not a command -- use e.g. "pr" with gh already implied';
    }
    return null;
}

// Resolves an "args" value (from config or msg.gh.args) into a string[].
// Strings are tokenized (quote-aware, no shell evaluation); arrays are used
// as-is (each element coerced to a string); anything else is rejected.
function resolveArgs(value) {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') return parseArgs(value);
    throw new Error('args must be a string or an array of strings, got ' + typeof value);
}

module.exports = function (RED) {
    function GhNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.command = config.command || '';
        node.commandType = config.commandType || 'str';
        node.args = config.args || '';
        node.argsType = config.argsType || 'str';
        node.repo = config.repo || '';
        node.repoType = config.repoType || 'str';
        node.host = config.host || '';
        node.timeoutMs = Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS;

        node.on('input', function (msg, send, done) {
            const ghOverride = (msg.gh && typeof msg.gh === 'object') ? msg.gh : {};

            // --- command ---
            let command;
            try {
                command = Object.prototype.hasOwnProperty.call(ghOverride, 'command')
                    ? ghOverride.command
                    : evalField(RED, node, msg, node.command, node.commandType);
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'bad command config' });
                done(err);
                return;
            }

            const commandError = validateCommand(command);
            if (commandError) {
                node.status({ fill: 'red', shape: 'ring', text: 'bad command' });
                done(new Error('gh: ' + commandError));
                return;
            }
            command = command.trim();

            // --- args ---
            let rawArgs;
            try {
                rawArgs = Object.prototype.hasOwnProperty.call(ghOverride, 'args')
                    ? ghOverride.args
                    : evalField(RED, node, msg, node.args, node.argsType);
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'bad args config' });
                done(err);
                return;
            }

            let args;
            try {
                args = resolveArgs(rawArgs);
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'bad args' });
                done(new Error('gh: ' + err.message));
                return;
            }

            // --- repo ---
            let repo;
            try {
                repo = Object.prototype.hasOwnProperty.call(ghOverride, 'repo')
                    ? ghOverride.repo
                    : evalField(RED, node, msg, node.repo, node.repoType);
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'bad repo config' });
                done(err);
                return;
            }
            repo = (repo === undefined || repo === null || repo === '') ? undefined : String(repo);

            // --- host (Advanced; simple str field, no typed input) ---
            const host = ghOverride.host || node.host || undefined;

            node.status({ fill: 'blue', shape: 'dot', text: 'running ' + command });

            const env = Object.assign({}, process.env);
            if (repo) env.GH_REPO = repo;
            if (host) env.GH_HOST = host;

            let stdout = '';
            let stderr = '';
            let child;
            try {
                child = spawn(GH_BINARY, [command, ...args], {
                    env,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    shell: false
                });
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'spawn failed' });
                done(err);
                return;
            }

            // Own explicit timeout instead of spawn()'s built-in timeout
            // option: it's simpler to reason about (we control exactly when
            // the timer is armed/cleared) and sidesteps that option's timer
            // not always being cleared promptly when the child never
            // actually starts (e.g. ENOENT).
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGTERM');
            }, node.timeoutMs);
            if (typeof timer.unref === 'function') timer.unref();

            child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
            child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

            child.on('error', (err) => {
                clearTimeout(timer);
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                const message = (err && err.code === 'ENOENT')
                    ? 'gh executable not found on PATH'
                    : 'failed to run gh: ' + err.message;
                const wrapped = new Error('gh: ' + message);
                wrapped.command = command;
                wrapped.args = args;
                done(wrapped);
            });

            child.on('close', (code, signal) => {
                clearTimeout(timer);
                if (signal) {
                    node.status({ fill: 'red', shape: 'ring', text: timedOut ? 'timeout' : 'killed' });
                    const err = new Error(
                        timedOut
                            ? 'gh: timed out after ' + node.timeoutMs + 'ms and was killed'
                            : 'gh: process killed by signal ' + signal
                    );
                    err.command = command;
                    err.args = args;
                    err.signal = signal;
                    err.timedOut = timedOut;
                    done(err);
                    return;
                }

                if (code !== 0) {
                    node.status({ fill: 'red', shape: 'dot', text: 'exit ' + code });
                    const err = new Error(
                        'gh: command failed (exit ' + code + ')' + (stderr.trim() ? ': ' + stderr.trim() : '')
                    );
                    err.command = command;
                    err.args = args;
                    err.exitCode = code;
                    err.stderr = stderr.trim();
                    done(err);
                    return;
                }

                const text = stdout.replace(/\r?\n$/, '');
                let payload;
                try {
                    payload = JSON.parse(text.trim());
                } catch (e) {
                    payload = text;
                }

                msg.payload = payload;
                msg.gh = {
                    command,
                    args,
                    repo: repo || '',
                    host: host || '',
                    exitCode: 0,
                    stderr: stderr.trim()
                };

                node.status({ fill: 'green', shape: 'dot', text: 'done' });
                const clearStatus = setTimeout(() => node.status({}), 2000);
                if (typeof clearStatus.unref === 'function') clearStatus.unref();
                send(msg);
                done();
            });

            node._child = child;
        });

        node.on('close', function (done) {
            if (node._child && !node._child.killed) {
                node._child.kill();
            }
            node.status({});
            done();
        });
    }

    RED.nodes.registerType('gh', GhNode);
};
