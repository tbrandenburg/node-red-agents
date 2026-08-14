'use strict';

// Shared spawn/timeout/kill logic used by both the Direct and SRT runtimes.
// Direct and SRT differ only in *which* command+args get spawned (see
// direct.js / srt.js) -- everything about process lifecycle, JSONL line
// buffering, and timeout handling lives here exactly once.
const { spawn } = require('child_process');

const GRACE_PERIOD_MS = 2000;

// executionId -> { child, timeoutTimer, killTimer, timedOut }
const registry = new Map();

function killProcessGroup(child, signal) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
        // `detached: true` (see runProcess) gives the child its own process
        // group with pgid === child.pid, so `-pid` reaches the whole tree
        // (e.g. srt's bwrap wrapper + the agent CLI it spawns), leaving no
        // orphans -- verified manually against a real `srt`-wrapped process.
        process.kill(-child.pid, signal);
    } catch (err) {
        try {
            child.kill(signal);
        } catch (_err) {
            // Process likely already exited between the check above and here.
        }
    }
}

function runProcess(executionRequest, handlers = {}) {
    const { id, cmd, args, cwd, env, timeoutMs } = executionRequest;

    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(cmd, args, {
                cwd: cwd || undefined,
                env: env || process.env,
                detached: true,
                // Agent CLIs (opencode, srt-wrapped or not) wait on stdin if
                // it's left open as a pipe; close it so they behave like a
                // normal non-interactive invocation (see AGENTS.md).
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (err) {
            reject(err);
            return;
        }

        const state = { child, timeoutTimer: null, killTimer: null, timedOut: false };
        registry.set(id, state);

        let lineBuffer = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            lineBuffer += chunk.toString();
            let idx;
            while ((idx = lineBuffer.indexOf('\n')) >= 0) {
                const line = lineBuffer.slice(0, idx);
                lineBuffer = lineBuffer.slice(idx + 1);
                if (handlers.onLine) handlers.onLine(line);
            }
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        if (timeoutMs && timeoutMs > 0) {
            state.timeoutTimer = setTimeout(() => {
                state.timedOut = true;
                killProcessGroup(child, 'SIGTERM');
                state.killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), GRACE_PERIOD_MS);
            }, timeoutMs);
        }

        child.on('error', (err) => {
            cleanupTimers(state);
            registry.delete(id);
            reject(err);
        });

        child.on('close', (code, signal) => {
            if (lineBuffer.length && handlers.onLine) handlers.onLine(lineBuffer);
            cleanupTimers(state);
            registry.delete(id);
            resolve({ exitCode: code, signal, stderr, timedOut: state.timedOut, pid: child.pid });
        });
    });
}

function cleanupTimers(state) {
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    if (state.killTimer) clearTimeout(state.killTimer);
}

function terminate(id) {
    const state = registry.get(id);
    if (!state) return;
    killProcessGroup(state.child, 'SIGTERM');
    state.killTimer = setTimeout(() => killProcessGroup(state.child, 'SIGKILL'), GRACE_PERIOD_MS);
}

module.exports = { runProcess, terminate, killProcessGroup, GRACE_PERIOD_MS };
