'use strict';

const { RuntimeProvider } = require('./base');
const { runProcess, terminate } = require('./process-exec');

const DEFAULT_BINARY = 'srt';

// Wraps execution in Anthropic's `srt` (sandbox-runtime) CLI, which is
// already installed on this host as a plain binary. Verified empirically
// (2026-08-13) that `srt`'s default invocation mode --
//   srt [-s <settings>] <command> [args...]
// -- passes each argv element through to the sandboxed child literally,
// with NO shell re-interpretation (confirmed with payloads containing
// `;`, `&&`, quotes, backticks). Only `srt -c "<string>"` behaves like
// `sh -c` and would be unsafe with untrusted args -- that mode is
// deliberately never used here.
//
// Because of this, SRT is implemented as a thin argv-prefix transform on
// top of the exact same process-exec.js used by Direct: no new npm
// dependency, no shell-quoting step, no separate process lifecycle code.
class SrtRuntime extends RuntimeProvider {
    constructor(options = {}) {
        super();
        this.binary = options.binary || DEFAULT_BINARY;
        // Left undefined by default so `srt` falls back to its own default
        // (~/.srt-settings.json) -- SRT policy is deliberately kept out of
        // the Agent node's core schema (spec: "SRT-specific configuration
        // should be hidden... implemented by the runtime adapter").
        this.settingsPath = options.settingsPath || undefined;
        this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    }

    buildCommand(executionRequest) {
        const flags = [];
        if (this.settingsPath) flags.push('-s', this.settingsPath);
        flags.push(...this.extraArgs);
        return {
            cmd: this.binary,
            args: [...flags, executionRequest.command, ...executionRequest.args]
        };
    }

    async execute(executionRequest, handlers) {
        const { cmd, args } = this.buildCommand(executionRequest);
        return runProcess(
            {
                id: executionRequest.id,
                cmd,
                args,
                cwd: executionRequest.cwd,
                env: executionRequest.env,
                timeoutMs: executionRequest.timeoutMs
            },
            handlers
        );
    }

    async terminate(executionId) {
        terminate(executionId);
    }
}

module.exports = { SrtRuntime };
