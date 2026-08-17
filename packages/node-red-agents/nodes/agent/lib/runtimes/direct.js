'use strict';

const { RuntimeProvider } = require('./base');
const { runProcess, terminate } = require('./process-exec');

// The portability baseline: runs the agent CLI directly as a child process
// wherever it's on PATH (laptop, GitHub runner, Kubernetes container, ...).
class DirectRuntime extends RuntimeProvider {
    async execute(executionRequest, handlers) {
        return runProcess(
            {
                id: executionRequest.id,
                cmd: executionRequest.command,
                args: executionRequest.args,
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

module.exports = { DirectRuntime };
