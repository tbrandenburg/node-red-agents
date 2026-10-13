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
async function runAgent({
  adapter,
  runtime,
  resolved,
  executionId,
  onEvent,
  onStatus,
  resolveAuth,
}) {
  const auth = resolveAuth ? resolveAuth(resolved) : undefined;
  const sanitize = auth ? auth.sanitize : (value) => value;
  const diagnostic = sanitize.diagnostic || sanitize;
  if (auth) resolved = { ...resolved, model: auth.model, cliProvider: auth.cliProvider };
  try {
    adapter.validate(resolved); // throws synchronously on bad config

    const built = adapter.buildExecution(resolved);
    const executionRequest = {
      id: executionId,
      command: built.command,
      args: built.args,
      cwd: resolved.cwd || undefined,
      env: Object.assign({}, auth ? auth.env : process.env, built.env || {}),
      timeoutMs: resolved.timeoutMs || undefined,
    };

    const events = [];
    const parsed = [];
    const groups = new WeakMap();
    const emit = (event, source) => {
      events.push(event);
      // Rejoin safe fragments from one original event: adapters may separate distinct events.
      if (source && groups.has(source)) {
        const prior = groups.get(source);
        prior.data.part.text += event.data.part.text;
      } else {
        const copy = source
          ? { ...event, data: { ...event.data, part: { ...event.data.part } } }
          : event;
        parsed.push(copy);
        if (source) groups.set(source, copy);
      }
      if (onEvent) onEvent(event);
    };
    const redactor = sanitize.events?.(emit);
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
          if (redactor) redactor.push(event);
          else emit(diagnostic(event));
        }
      },
    });
    redactor?.flush();

    const durationMs = Date.now() - startedAt;
    const result = adapter.parseResult(
      parsed,
      outcome.exitCode,
      outcome.signal,
      diagnostic(outcome.stderr),
      resolved,
    );
    const status = outcome.timedOut ? "timeout" : result.status;

    if (onStatus) onStatus(status);

    return sanitize(
      Object.assign({}, result, {
        status,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        durationMs,
        events,
      }),
    );
  } catch (error) {
    throw auth ? auth.safeError(error) : error;
  }
}

module.exports = { runAgent };
