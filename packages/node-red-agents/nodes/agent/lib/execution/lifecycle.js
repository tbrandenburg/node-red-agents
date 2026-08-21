"use strict";

// Framework-agnostic orchestrator: given an adapter, a runtime, and an
// already-resolved (typed-input-evaluated) input object, runs one agent
// execution end to end. Deliberately has no Node-RED dependency so it can
// be unit-tested with fake adapters/runtimes (see test/execution/).
//
// `resolved` shape (built by agent.js from node config + msg):
//   {
//     invocation: 'prompt' | 'skill' | 'command',
//     prompt, name, args,   // per invocation mode
//     cwd, model, auto,
//     timeoutMs,
//     mcpServers: []
//   }
//
// `callbacks`:
//   onEvent(event)   -- called for every parsed stdout event (output 2)
//   onStatus(status) -- 'running' | 'completed' | 'failed' | 'timeout'
async function runAgent({ adapter, runtime, resolved, executionId, onEvent, onStatus }) {
  adapter.validate(resolved); // throws synchronously on bad config

  const built = adapter.buildExecution(resolved);
  const executionRequest = {
    id: executionId,
    command: built.command,
    args: built.args,
    cwd: resolved.cwd || undefined,
    env: Object.assign({}, process.env, built.env || {}),
    timeoutMs: resolved.timeoutMs || undefined,
  };

  const events = [];
  const startedAt = Date.now();
  if (onStatus) onStatus("running");

  const outcome = await runtime.execute(executionRequest, {
    onLine: (line) => {
      let event;
      try {
        event = adapter.parseEvent(line);
      } catch (err) {
        // parseEvent must never crash the node; treat as ignorable.
        event = null;
      }
      if (event) {
        events.push(event);
        if (onEvent) onEvent(event);
      }
    },
  });

  const durationMs = Date.now() - startedAt;
  const result = adapter.parseResult(events, outcome.exitCode, outcome.signal, outcome.stderr, resolved);
  const status = outcome.timedOut ? "timeout" : result.status;

  if (onStatus) onStatus(status);

  return Object.assign({}, result, {
    status,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    durationMs,
    events,
  });
}

module.exports = { runAgent };
