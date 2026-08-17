"use strict";

// Generic interface every runtime (Direct, SRT, and later Daytona/OpenShell)
// must implement. Agent adapters never depend on a runtime directly, and
// runtimes never depend on an agent adapter -- they only see the normalized
// executionRequest built by lib/execution/lifecycle.js.
class RuntimeProvider {
  // executionRequest: { id, command, args, cwd, env, timeoutMs }
  // handlers: { onLine(line: string), onExit(...) } -- onExit is not
  // called directly by implementations; execute() resolves instead with
  // { exitCode, signal, stderr, timedOut }.
  async execute(_executionRequest, _handlers) {
    throw new Error("RuntimeProvider.execute() not implemented");
  }

  async terminate(_executionId) {}

  async cleanup(_executionId) {}
}

module.exports = { RuntimeProvider };
