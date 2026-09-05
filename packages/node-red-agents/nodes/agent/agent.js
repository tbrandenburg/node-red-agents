const fs = require("fs");
const { OpenCodeAdapter } = require("./lib/agents/opencode");
const { PiAdapter } = require("./lib/agents/pi");
const { DirectRuntime } = require("./lib/runtimes/direct");
const { SrtRuntime } = require("./lib/runtimes/srt");
const { writeInlineSettingsFile } = require("../../shared/srt-settings");
const { runAgent } = require("./lib/execution/lifecycle");
const { ExecutionScheduler } = require("./lib/execution/scheduler");
const { computeNodeStatus } = require("./lib/execution/status");
const { getCapabilities } = require("./lib/agents/capabilities");
const { shouldRetry } = require("./lib/execution/retry");
const { substituteInputs } = require("./lib/execution/inputs");
const {
  STRUCTURED_OUTPUT_MAX_REASKS,
  compileOutputFormat,
  tryParseStructuredOutput,
  augmentPromptForSchema,
  buildReaskPrompt,
} = require("./lib/execution/structured-output");

// Registries. Adding a future adapter/runtime is just one more entry here --
// nothing else in this file (or in lib/execution/lifecycle.js) needs to
// change, per the spec's adapter-independence requirement. Concurrency
// (lib/execution/scheduler.js) is likewise fully independent of both: it
// only ever sees opaque { executionId, ... } items.
const AGENTS = {
  opencode: () => new OpenCodeAdapter(),
  pi: () => new PiAdapter(),
};

function buildRuntime(node) {
  if (node.runtime === "srt") {
    return new SrtRuntime({
      binary: node.srtBinary || undefined,
      settingsPath: node.resolvedSrtSettingsPath || undefined,
    });
  }
  return new DirectRuntime();
}

let executionCounter = 0;
function nextExecutionId() {
  executionCounter += 1;
  return `exec-${Date.now()}-${executionCounter}`;
}

module.exports = function (RED) {
  "use strict";

  function AgentNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.agent = config.agent || "opencode";
    node.runtime = config.runtime || "direct";
    node.invocation = config.invocation || "prompt";

    // Typed-input override of the agentName reported on outgoing/event
    // messages (see lifecycleEnvelope below). Same typed-input pattern as
    // every other overridable field: blank/unresolved falls back to
    // node.name, so existing flows relying on the (previously static)
    // node.name value keep working unchanged.
    node.agentName = config.agentName !== undefined ? config.agentName : "";
    node.agentNameType = config.agentNameType || "str";

    node.model = config.model || "";
    node.modelType = config.modelType || "str";

    node.prompt = config.prompt !== undefined ? config.prompt : "payload";
    node.promptType = config.promptType || "msg";

    // Same name/default/type as the agent-server node's sessionIdProp:
    // absent/blank on a run -> a brand-new session is started (today's
    // only behavior); present -> that session is resumed instead (only
    // the OpenCode adapter supports this -- see lib/agents/opencode.js
    // and lib/agents/pi.js).
    node.sessionIdProp = config.sessionIdProp !== undefined ? config.sessionIdProp : "sessionID";
    node.sessionIdPropType = config.sessionIdPropType || "msg";

    node.invocationName = config.invocationName || "";
    node.invocationNameType = config.invocationNameType || "str";

    node.arguments_ = config.arguments !== undefined ? config.arguments : "payload";
    node.argumentsType = config.argumentsType || "msg";

    // Named, multi-value $INPUTS.<name> templating (issue #20): a list of
    // { name, value, valueType } typed-input entries, each resolved
    // per-message via resolveTyped below and substituted into the
    // resolved arguments string before it's handed to either adapter.
    // Pure text templating, zero adapter-specific code -- see
    // lib/execution/inputs.js. Default empty list = zero behavior change.
    node.inputs = Array.isArray(config.inputs) ? config.inputs : [];

    node.cwd = config.cwd !== undefined ? config.cwd : "cwd";
    node.cwdType = config.cwdType || "msg";

    node.auto = config.auto === true;

    node.timeout = config.timeout !== undefined ? config.timeout : "";
    node.timeoutType = config.timeoutType || "num";

    node.mcpServers = Array.isArray(config.mcpServers) ? config.mcpServers : [];

    // Optional per-adapter capability-gated fields (issue #25), modeled on
    // Archon's DagNodeBase: systemPrompt override, effort (reasoning
    // depth), and allowed/denied tool lists. Each is only ever honored by
    // an adapter whose CAPABILITIES flag says it's actually wired up (see
    // lib/agents/capabilities.js) -- otherwise startExecution below warns
    // once and drops it, never a hard error.
    node.systemPrompt = config.systemPrompt !== undefined ? config.systemPrompt : "";
    node.systemPromptType = config.systemPromptType || "str";

    node.effort = config.effort !== undefined ? config.effort : "";
    node.effortType = config.effortType || "str";

    node.allowedTools = Array.isArray(config.allowedTools) ? config.allowedTools : [];
    node.deniedTools = Array.isArray(config.deniedTools) ? config.deniedTools : [];

    // Node-level retry (issue #24): fully opt-in-by-default at a
    // conservative setting (2 total attempts = 1 original + 1 retry, per
    // the issue's "default 2 attempts" wording), gated by a small
    // transient-vs-fatal string classifier (lib/execution/retry.js) so a
    // fatal error (bad auth, quota exhaustion) never burns a retry. See
    // startExecution below for the actual retry loop.
    node.retryMaxAttempts = Number.isFinite(Number(config.retryMaxAttempts))
      ? Math.max(1, Number(config.retryMaxAttempts))
      : 2;
    node.retryDelayMs = Number.isFinite(Number(config.retryDelayMs))
      ? Math.max(0, Number(config.retryDelayMs))
      : 3000;
    node.retryOnError = config.retryOnError === "all" ? "all" : "transient";

    // output_format (issue #23): fully opt-in, JSON-Schema-as-text config
    // field. Compiled once here (deploy time), not per-execution -- a bad
    // schema or an adapter that doesn't support structured output at all
    // (capabilities.structuredOutput === false) sets node.outputFormatError,
    // which the input handler below checks before ever building an
    // execution, mirroring the existing srtSettingsError deploy-time-
    // validation pattern above.
    node.outputFormat = config.outputFormat !== undefined ? config.outputFormat : "";
    node.compiledOutputFormat = undefined; // AJV validate fn, if configured+valid
    node.outputFormatSchema = undefined; // parsed schema object, if configured+valid
    node.outputFormatError = undefined;

    if (node.outputFormat && String(node.outputFormat).trim()) {
      let schema;
      try {
        schema = JSON.parse(node.outputFormat);
      } catch (err) {
        node.outputFormatError = `invalid output_format schema: ${err.message}`;
      }
      if (!node.outputFormatError) {
        const compiled = compileOutputFormat(schema);
        if (compiled.error) {
          node.outputFormatError = `invalid output_format schema: ${compiled.error}`;
        } else {
          node.compiledOutputFormat = compiled.validate;
          node.outputFormatSchema = schema;
        }
      }
      if (!node.outputFormatError && AGENTS[node.agent]) {
        const capabilities = getCapabilities(AGENTS[node.agent]());
        if (capabilities.structuredOutput === false) {
          node.outputFormatError = `output_format not supported by ${node.agent}`;
        }
      }
      if (node.outputFormatError) {
        node.error(`agent: ${node.outputFormatError}`);
        node.status({ fill: "red", shape: "ring", text: node.outputFormatError });
      }
    }

    node.srtBinary = config.srtBinary || "";
    node.srtSettingsMode = config.srtSettingsMode || "file";
    node.srtSettingsPath = config.srtSettingsPath || "";
    node.srtAllowedDomains = Array.isArray(config.srtAllowedDomains)
      ? config.srtAllowedDomains
      : [];
    node.srtAllowedWriteDirs = Array.isArray(config.srtAllowedWriteDirs)
      ? config.srtAllowedWriteDirs
      : [];
    node.srtStrictAllowlist = config.srtStrictAllowlist !== false;
    node.srtAdvancedJson = config.srtAdvancedJson || "";

    // Resolved once at construction time (not per-execution -- these
    // settings don't change without a redeploy). For 'file' mode this
    // is just srtSettingsPath itself; for 'inline' mode it's a
    // generated temp settings file. node.resolvedSrtSettingsPath stays
    // undefined (srt falls back to its own default) if unset/failed.
    node.resolvedSrtSettingsPath = undefined;
    node.srtTempSettingsFile = undefined;
    node.srtSettingsError = undefined;

    if (node.runtime === "srt") {
      if (node.srtSettingsMode === "inline") {
        try {
          node.resolvedSrtSettingsPath = writeInlineSettingsFile(node.id, {
            allowedDomains: node.srtAllowedDomains,
            allowedWriteDirs: node.srtAllowedWriteDirs,
            strictAllowlist: node.srtStrictAllowlist,
            advancedJson: node.srtAdvancedJson,
          });
          node.srtTempSettingsFile = node.resolvedSrtSettingsPath;
        } catch (err) {
          node.srtSettingsError = `invalid inline SRT settings JSON: ${err.message}`;
          node.error(`agent: ${node.srtSettingsError}`);
          node.status({ fill: "red", shape: "ring", text: "bad srt settings" });
        }
      } else {
        node.resolvedSrtSettingsPath = node.srtSettingsPath || undefined;
      }
    }

    // Default 1 = sequential, matching today's single-node-single-run
    // mental model unless a flow author explicitly opts into more.
    const concurrencyNum = parseInt(config.concurrency, 10);
    node.concurrency = Number.isFinite(concurrencyNum) && concurrencyNum > 0 ? concurrencyNum : 1;

    // Last terminal outcome, shown once active+queued both drop to 0.
    node.lastTerminal = undefined;
    node.lastText = undefined;

    function updateStatus() {
      node.status(
        computeNodeStatus({
          active: node.scheduler.activeCount,
          queued: node.scheduler.queuedCount,
          lastTerminal: node.lastTerminal,
          lastText: node.lastText,
        }),
      );
    }

    // Resolves a typed-input field the same way for every field: an
    // empty property path is only meaningful for type 'str' (falls
    // through to `fallback`); for 'msg'/'flow'/'global'/'env' an empty
    // path is invalid, so it's never even evaluated.
    function resolveTyped(prop, type, msg, fallback) {
      if (prop === "") return fallback;
      try {
        const value = RED.util.evaluateNodeProperty(prop, type, node, msg);
        return value === undefined || value === null ? fallback : value;
      } catch (err) {
        throw new Error(`invalid ${type} property "${prop}": ${err.message}`, { cause: err });
      }
    }

    // Per-message resolution of the reported agentName: the typed-input
    // agentName/agentNameType field (e.g. msg.agentName) if configured and
    // present, else node.name -- same fallback behavior a blank/unset
    // typed-input field has always had for every other field.
    function resolveAgentName(msg) {
      const v = resolveTyped(node.agentName, node.agentNameType, msg, node.name);
      return v === undefined || v === null || v === "" ? node.name : String(v).trim();
    }

    // Common envelope for every message on output 2 (the lifecycle/event
    // stream): correlation (topic, executionId), live scheduler counts
    // (so a widget bound to this stream always has the current
    // active/queued numbers, no separate polling needed) and a
    // timestamp (so external aggregation/history doesn't have to rely
    // on message-arrival time).
    function lifecycleEnvelope(msg, executionId, payload, agentName, cwd) {
      return {
        _msgid: msg._msgid,
        topic: msg.topic,
        payload,
        agent: node.agent,
        runtime: node.runtime,
        agentId: node.id,
        agentName,
        cwd,
        executionId,
        active: node.scheduler.activeCount,
        queued: node.scheduler.queuedCount,
        timestamp: Date.now(),
      };
    }

    // `extra` (e.g. { costUsd, tokens } -- see startExecution/onSettled
    // below) is merged into the { type } payload only when provided, so
    // every other emitEvent call site (queued/cancelled/running/etc.)
    // keeps its existing { type }-only payload shape unchanged.
    function emitEvent(send, msg, executionId, type, agentName, cwd, extra) {
      send([
        null,
        lifecycleEnvelope(msg, executionId, Object.assign({ type }, extra), agentName, cwd),
      ]);
    }

    // The actual work for one execution. Only ever invoked by the
    // scheduler once a concurrency slot is free -- never called
    // directly from the input handler.
    function startExecution(item) {
      const { executionId, msg, send, done, resolved } = item;
      const adapter = AGENTS[node.agent]();
      const runtime = buildRuntime(node);
      const capabilities = getCapabilities(adapter);

      // Capability-gated warn-and-drop (issue #25): a field the user
      // configured but this adapter doesn't actually wire up gets exactly
      // one node.warn per run here -- never a hard error, and never a
      // silent no-op either. Adapters themselves only ever act on these
      // fields when their own CAPABILITIES flag agrees (see opencode.js/
      // pi.js), so this is the single place responsible for surfacing
      // the "ignored" case to the flow author.
      function warnUnsupported(field, isSet, supported) {
        if (isSet && !supported) {
          node.warn(`${field} is not supported by the ${node.agent} adapter and will be ignored`);
        }
      }
      warnUnsupported("systemPrompt", !!resolved.systemPrompt, capabilities.systemPromptControl);
      warnUnsupported("effort", !!resolved.effort, capabilities.effortControl);
      warnUnsupported(
        "allowed_tools",
        Array.isArray(resolved.allowedTools) && resolved.allowedTools.length > 0,
        capabilities.toolRestrictions,
      );
      warnUnsupported(
        "denied_tools",
        Array.isArray(resolved.deniedTools) && resolved.deniedTools.length > 0,
        capabilities.toolRestrictions,
      );

      function invoke(currentResolved) {
        return runAgent({
          adapter,
          runtime,
          resolved: currentResolved,
          executionId,
          onEvent: (event) => {
            send([
              null,
              lifecycleEnvelope(msg, executionId, event, resolved.agentName, resolved.cwd),
            ]);
          },
          onStatus: (status) => {
            if (status === "running") {
              emitEvent(send, msg, executionId, "running", resolved.agentName, resolved.cwd);
            } else {
              // Terminal (completed/failed/timeout): stash rather
              // than emit immediately -- the scheduler hasn't
              // removed this execution from `active` yet at this
              // point, so the active/queued counts on the
              // envelope would be stale by one. onSettled (below)
              // emits it once the scheduler's own bookkeeping,
              // including any newly-started queued item, is
              // fully settled.
              item.finalStatus = status;
            }
          },
        });
      }

      // output_format (issue #23): only ever engaged for prompt invocation
      // with a compiled schema (deploy-time-validated -- see the
      // constructor above). Runs the adapter once with the prompt
      // augmented to ask for schema-matching JSON, then parses+validates
      // the result; on failure, best-effort adapters (capabilities.
      // structuredOutput === "best-effort") get up to
      // STRUCTURED_OUTPUT_MAX_REASKS additional turns (reusing the prior
      // sessionID when capabilities.sessionResume is true, so context
      // isn't lost) before the whole execution is reported as failed --
      // it must never silently fall back to raw, unvalidated text.
      const outputFormat = node.compiledOutputFormat
        ? { validate: node.compiledOutputFormat, schema: node.outputFormatSchema }
        : undefined;
      const structuredEnabled = !!outputFormat && resolved.invocation === "prompt";

      async function executeWithStructuredOutput(execResolved) {
        const firstResolved = structuredEnabled
          ? Object.assign({}, execResolved, {
              prompt: augmentPromptForSchema(execResolved.prompt, outputFormat.schema),
            })
          : execResolved;

        let result = await invoke(firstResolved);
        if (!structuredEnabled || result.status !== "completed") return result;

        let parsed = tryParseStructuredOutput(result.payload);
        let valid = parsed !== undefined && outputFormat.validate(parsed);
        let lastErrors = outputFormat.validate.errors;
        let attempts = 0;
        const maxReasks =
          capabilities.structuredOutput === "best-effort" ? STRUCTURED_OUTPUT_MAX_REASKS : 0;

        while (!valid && attempts < maxReasks) {
          attempts += 1;
          const reaskResolved = Object.assign({}, execResolved, {
            prompt: buildReaskPrompt(execResolved.prompt, outputFormat.schema, lastErrors),
            sessionID:
              capabilities.sessionResume && result.sessionID
                ? result.sessionID
                : execResolved.sessionID,
          });
          result = await invoke(reaskResolved);
          if (result.status !== "completed") break;
          parsed = tryParseStructuredOutput(result.payload);
          valid = parsed !== undefined && outputFormat.validate(parsed);
          lastErrors = outputFormat.validate.errors;
        }

        if (!valid) {
          const errText =
            lastErrors && lastErrors.length
              ? lastErrors.map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ")
              : "response was not valid JSON matching output_format";
          return Object.assign({}, result, {
            status: "failed",
            errorMessage: `output_format validation failed after ${attempts} reask(s): ${errText}`,
          });
        }

        return Object.assign({}, result, { structuredOutput: parsed });
      }

      function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      // Node-level retry (issue #24): a whole executeWithStructuredOutput()
      // call (first attempt + any reasks) counts as one "attempt" here --
      // retries only kick in once that entire pipeline has settled on a
      // final failed/timeout result. Runs inside this one scheduler slot
      // (see the module header comment on ExecutionScheduler's contract)
      // -- never re-`submit()`s to the scheduler, so no duplicate
      // queued/running events and no extra slot churn.
      async function executeWithRetry() {
        let currentResolved = resolved;
        let attempt = 1;
        for (;;) {
          const result = await executeWithStructuredOutput(currentResolved);
          const isTerminalFailure = result.status === "failed" || result.status === "timeout";
          if (
            !isTerminalFailure ||
            attempt >= node.retryMaxAttempts ||
            !shouldRetry(result, node.retryOnError)
          ) {
            return result;
          }

          attempt += 1;
          emitEvent(send, msg, executionId, "retrying", resolved.agentName, resolved.cwd, {
            attempt,
            maxAttempts: node.retryMaxAttempts,
          });

          if (node.retryDelayMs > 0) await delay(node.retryDelayMs);

          // Session-reuse-on-retry: only when the adapter can actually
          // resume a session (capabilities.sessionResume, e.g. opencode)
          // and the failed attempt got far enough to mint one -- pi
          // (sessionResume: false) always retries sessionless, unchanged.
          currentResolved =
            capabilities.sessionResume && result.sessionID
              ? Object.assign({}, currentResolved, { sessionID: result.sessionID })
              : currentResolved;
        }
      }

      return executeWithRetry()
        .then((result) => {
          node.lastTerminal = result.status;
          node.lastText = undefined;

          // output_format success (issue #23): canonicalize msg.payload to
          // the parsed-then-restringified JSON text (not the adapter's
          // possibly fence-wrapped/padded raw text), and stash the parsed
          // object separately on agentExecution below.
          if (
            structuredEnabled &&
            result.status === "completed" &&
            result.structuredOutput !== undefined
          ) {
            result = Object.assign({}, result, {
              payload: JSON.stringify(result.structuredOutput),
            });
          }

          const agentExecution = {
            id: executionId,
            status: result.status,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            sessionID: result.sessionID,
            // Raw error object from the adapter (e.g. opencode's full
            // {"type":"error"} payload, or pi's failing assistant
            // message) when the run failed -- the `done(err)` string
            // below only carries a single summarized message/name, so
            // anything needing the fuller detail (extra fields the
            // adapter didn't fold into errorMessage) should wire a
            // Debug node to output 1 and inspect this field.
            errorDetail: result.errorDetail,
          };
          if (structuredEnabled && result.structuredOutput !== undefined) {
            agentExecution.structuredOutput = result.structuredOutput;
            agentExecution.declaredFields = Object.keys(
              (outputFormat.schema && outputFormat.schema.properties) || {},
            );
          }

          // Only adapters declaring costReporting (see
          // lib/agents/capabilities.js) ever populate result.costUsd/
          // .tokens (e.g. opencode.js's parseResult) -- checking the
          // capability first, rather than just `!== undefined`, means an
          // adapter that isn't wired for this can never leak a stray
          // key even if its result object happens to carry one.
          let usage;
          if (capabilities.costReporting) {
            if (result.costUsd !== undefined) agentExecution.costUsd = result.costUsd;
            if (result.tokens !== undefined) agentExecution.tokens = result.tokens;
            if (agentExecution.costUsd !== undefined || agentExecution.tokens !== undefined) {
              usage = {};
              if (agentExecution.costUsd !== undefined) usage.costUsd = agentExecution.costUsd;
              if (agentExecution.tokens !== undefined) usage.tokens = agentExecution.tokens;
            }
          }
          // Stashed for onSettled below (the deferred terminal lifecycle
          // event on output 2, see the onStatus comment above) -- by the
          // time onSettled fires this Promise has already resolved, so
          // item.finalUsage is guaranteed to be set.
          item.finalUsage = usage;

          const resultMsg = Object.assign({}, msg, {
            payload: result.status === "completed" ? result.payload : null,
            agent: node.agent,
            runtime: node.runtime,
            agentId: node.id,
            agentName: resolved.agentName,
            // Top-level, in addition to agentExecution.sessionID
            // below: matches the agent-server node's convention
            // so this output can be fed straight back into the
            // (default) Session ID field -- msg.sessionID -- of
            // this or another agent node with no extra wiring.
            sessionID: result.sessionID,
            agentExecution,
          });
          send([resultMsg, null]);

          if (result.status === "failed" || result.status === "timeout") {
            done(
              `agent (${node.agent}/${node.runtime}): ${result.status}` +
                (result.errorMessage ? ` -- ${result.errorMessage}` : "") +
                ` [executionId=${executionId} cwd=${resolved.cwd || "(default)"} exitCode=${result.exitCode}]`,
            );
          } else {
            done();
          }
        })
        .catch((err) => {
          node.lastTerminal = "failed";
          node.lastText = "error";
          // Covers e.g. adapter.validate() throwing synchronously,
          // before onStatus('running') ever fires -- still needs a
          // terminal lifecycle event for anything tracking this
          // execution by executionId/topic.
          item.finalStatus = "failed";
          done(
            new Error(
              `agent (${node.agent}/${node.runtime}) [executionId=${executionId}]: ${err.message}`,
            ),
          );
        });
    }

    node.scheduler = new ExecutionScheduler({
      concurrency: node.concurrency,
      onStart: startExecution,
      onQueued: (item) =>
        emitEvent(item.send, item.msg, item.executionId, "queued", item.resolved.agentName),
      // Runs after this item is removed from `active` and any newly-
      // eligible queued item has already been started, so the terminal
      // event's active/queued counts are accurate (see the onStatus
      // comment in startExecution for why it's deferred to here).
      onSettled: (item) => {
        if (item.finalStatus) {
          emitEvent(
            item.send,
            item.msg,
            item.executionId,
            item.finalStatus,
            item.resolved.agentName,
            item.resolved.cwd,
            item.finalUsage,
          );
        }
        updateStatus();
      },
    });

    // On-demand termination of one in-flight (or still-queued) execution
    // of *this* node instance, addressed by the executionId a previous
    // trigger returned (msg.agentExecution.id / the events envelope's
    // executionId). A separate msg from the one being terminated -- the
    // terminated execution's own original done()/outputs still fire on
    // their own once the process actually exits (status 'failed' with a
    // SIGTERM/SIGKILL signal, same as any other non-zero exit), this
    // handler's output/done is only the immediate "kill requested" ack.
    function handleTerminateOperation(msg, send, done) {
      const executionId = typeof msg.executionId === "string" ? msg.executionId.trim() : "";
      if (!executionId) {
        done(new Error("agent: terminate requires msg.executionId"));
        return;
      }

      const agentName = resolveAgentName(msg);
      const result = node.scheduler.cancel(executionId);
      if (!result) {
        done(new Error(`agent: unknown or already-finished executionId "${executionId}"`));
        return;
      }

      if (result.status === "queued") {
        const queuedItem = result.item;
        emitEvent(
          queuedItem.send,
          queuedItem.msg,
          executionId,
          "cancelled",
          queuedItem.resolved ? queuedItem.resolved.agentName : agentName,
        );
        queuedItem.done(
          new Error("agent: execution cancelled before it started (terminate requested)"),
        );
        updateStatus();
        send([
          Object.assign({}, msg, {
            payload: { executionId, terminated: true, status: "cancelled" },
            agentId: node.id,
            agentName,
          }),
          null,
        ]);
        done();
        return;
      }

      // Active: send SIGTERM (escalating to SIGKILL) to the whole
      // process group. Works identically for both the direct and srt
      // runtimes -- see process-exec.js's killProcessGroup -- so no
      // per-runtime branching is needed here.
      const runtime = buildRuntime(node);
      Promise.resolve(runtime.terminate(executionId))
        .then(() => {
          send([
            Object.assign({}, msg, {
              payload: { executionId, terminated: true, status: "terminating" },
              agentId: node.id,
              agentName,
            }),
            null,
          ]);
          done();
        })
        .catch((err) => done(err));
    }

    node.on("input", function (msg, send, done) {
      if (node.srtSettingsError) {
        node.lastTerminal = "failed";
        node.lastText = "bad srt settings";
        updateStatus();
        done(new Error(`agent: ${node.srtSettingsError}`));
        return;
      }

      if (node.outputFormatError) {
        node.lastTerminal = "failed";
        node.lastText = "bad output_format";
        updateStatus();
        done(new Error(`agent: ${node.outputFormatError}`));
        return;
      }

      if (msg.operation === "terminate") {
        handleTerminateOperation(msg, send, done);
        return;
      }

      // Optional per-message override of the deploy-time Concurrency
      // field, applied before this message is submitted so a raised
      // bound can immediately start any items already queued from
      // earlier messages. Invalid values (non-numeric/non-positive)
      // are ignored -- see ExecutionScheduler.setConcurrency.
      if (msg.concurrency !== undefined) {
        node.scheduler.setConcurrency(Number(msg.concurrency));
      }

      let resolved;
      try {
        resolved = {
          agentName: resolveAgentName(msg),
          invocation: node.invocation,
          prompt:
            node.invocation === "prompt"
              ? resolveTyped(node.prompt, node.promptType, msg, msg.payload)
              : undefined,
          invocationName:
            node.invocation !== "prompt"
              ? resolveTyped(node.invocationName, node.invocationNameType, msg, "")
              : undefined,
          args:
            node.invocation !== "prompt"
              ? (() => {
                  const raw = resolveTyped(node.arguments_, node.argumentsType, msg, msg.payload);
                  if (typeof raw !== "string" || node.inputs.length === 0) return raw;
                  const inputsMap = {};
                  node.inputs.forEach((entry) => {
                    inputsMap[entry.name] = resolveTyped(
                      entry.value,
                      entry.valueType || "msg",
                      msg,
                      "",
                    );
                  });
                  // issue #29: warn once per distinct unmatched $INPUTS.<name>
                  // token found in this run (de-duplicated so a typo'd token
                  // repeated in `arguments` doesn't spam the log) -- purely
                  // additive observability, the substituted text itself (and
                  // thus the eventual invocation) is unchanged.
                  const unmatchedNames = new Set();
                  const substituted = substituteInputs(raw, inputsMap, (name) =>
                    unmatchedNames.add(name),
                  );
                  unmatchedNames.forEach((name) => {
                    node.warn(
                      `$INPUTS.${name} has no matching 'inputs' entry and was left unsubstituted`,
                    );
                  });
                  return substituted;
                })()
              : undefined,
          cwd: (() => {
            const v = resolveTyped(node.cwd, node.cwdType, msg, "");
            return v === undefined || v === null ? "" : String(v).trim();
          })(),
          sessionID: (() => {
            const v = resolveTyped(node.sessionIdProp, node.sessionIdPropType, msg, "");
            return v === undefined || v === null ? "" : String(v).trim();
          })(),
          model: (() => {
            const v = resolveTyped(node.model, node.modelType, msg, "");
            return v === undefined || v === null ? "" : String(v).trim();
          })(),
          auto: node.auto,
          timeoutMs: (() => {
            const v = resolveTyped(node.timeout, node.timeoutType, msg, undefined);
            const num = Number(v);
            return v === undefined || v === "" || !Number.isFinite(num) || num <= 0
              ? undefined
              : num * 1000;
          })(),
          mcpServers: node.mcpServers,
          systemPrompt: (() => {
            const v = resolveTyped(node.systemPrompt, node.systemPromptType, msg, "");
            return v === undefined || v === null ? "" : String(v).trim();
          })(),
          effort: (() => {
            const v = resolveTyped(node.effort, node.effortType, msg, "");
            return v === undefined || v === null ? "" : String(v).trim();
          })(),
          allowedTools: node.allowedTools,
          deniedTools: node.deniedTools,
        };
      } catch (err) {
        node.lastTerminal = "failed";
        node.lastText = "bad config";
        updateStatus();
        done(err);
        return;
      }

      if (!AGENTS[node.agent]) {
        node.lastTerminal = "failed";
        node.lastText = "unknown agent";
        updateStatus();
        done(new Error(`agent: unknown agent "${node.agent}"`));
        return;
      }

      const executionId = nextExecutionId();
      node.scheduler.submit({ executionId, msg, send, done, resolved });
      updateStatus();
    });

    node.on("close", function (done) {
      // Stop accepting further work first: drop anything still
      // waiting in the queue with a clean done()/cancelled event,
      // then terminate whatever's still actively running. No child
      // process should be orphaned by a redeploy or node removal.
      node.scheduler.drainQueue((item) => {
        emitEvent(item.send, item.msg, item.executionId, "cancelled");
        item.done(new Error("agent: node closing, execution cancelled before it started"));
      });

      const runtime = buildRuntime(node);
      const activeIds = node.scheduler.activeIds();
      Promise.all(
        activeIds.map((id) => Promise.resolve(runtime.terminate(id)).catch(() => {})),
      ).then(() => {
        if (node.srtTempSettingsFile) {
          fs.unlink(node.srtTempSettingsFile, () => {});
        }
        node.status({});
        done();
      });
    });
  }

  RED.nodes.registerType("agent", AgentNode);
};
