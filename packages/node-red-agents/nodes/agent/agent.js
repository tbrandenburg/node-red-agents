const fs = require("fs");
const { OpenCodeAdapter } = require("./lib/agents/opencode");
const { PiAdapter } = require("./lib/agents/pi");
const { DirectRuntime } = require("./lib/runtimes/direct");
const { SrtRuntime } = require("./lib/runtimes/srt");
const { writeInlineSettingsFile } = require("../../shared/srt-settings");
const { runAgent } = require("./lib/execution/lifecycle");
const { ExecutionScheduler } = require("./lib/execution/scheduler");
const { computeNodeStatus } = require("./lib/execution/status");

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

    node.cwd = config.cwd !== undefined ? config.cwd : "cwd";
    node.cwdType = config.cwdType || "msg";

    node.auto = config.auto === true;

    node.timeout = config.timeout !== undefined ? config.timeout : "";
    node.timeoutType = config.timeoutType || "num";

    node.mcpServers = Array.isArray(config.mcpServers) ? config.mcpServers : [];

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
        throw new Error(`invalid ${type} property "${prop}": ${err.message}`);
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
    function lifecycleEnvelope(msg, executionId, payload, agentName) {
      return {
        _msgid: msg._msgid,
        topic: msg.topic,
        payload,
        agent: node.agent,
        runtime: node.runtime,
        agentId: node.id,
        agentName,
        executionId,
        active: node.scheduler.activeCount,
        queued: node.scheduler.queuedCount,
        timestamp: Date.now(),
      };
    }

    function emitEvent(send, msg, executionId, type, agentName) {
      send([null, lifecycleEnvelope(msg, executionId, { type }, agentName)]);
    }

    // The actual work for one execution. Only ever invoked by the
    // scheduler once a concurrency slot is free -- never called
    // directly from the input handler.
    function startExecution(item) {
      const { executionId, msg, send, done, resolved } = item;
      const adapter = AGENTS[node.agent]();
      const runtime = buildRuntime(node);

      return runAgent({
        adapter,
        runtime,
        resolved,
        executionId,
        onEvent: (event) => {
          send([null, lifecycleEnvelope(msg, executionId, event, resolved.agentName)]);
        },
        onStatus: (status) => {
          if (status === "running") {
            emitEvent(send, msg, executionId, "running", resolved.agentName);
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
      })
        .then((result) => {
          node.lastTerminal = result.status;
          node.lastText = undefined;

          const resultMsg = Object.assign({}, msg, {
            payload: result.payload,
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
            agentExecution: {
              id: executionId,
              status: result.status,
              exitCode: result.exitCode,
              signal: result.signal,
              timedOut: result.timedOut,
              durationMs: result.durationMs,
              sessionID: result.sessionID,
            },
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
              ? resolveTyped(node.arguments_, node.argumentsType, msg, msg.payload)
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
