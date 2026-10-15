"use strict";

const fs = require("fs");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("child_process");
const { findFreePort } = require("./lib/port");
const { InstanceRegistry } = require("./lib/registry");
const { spawnDaemon, waitForHealthy, killDaemon } = require("./lib/daemon");
const { computeNodeStatus } = require("./lib/status");
const { writeInlineSettingsFile } = require("../../shared/srt-settings");
const { request } = require("./lib/http");
const { parseModel } = require("./lib/model");
const { createDaemonAuth } = require("./lib/auth");
const apiV2 = require("./lib/api");
const { settleTurn } = require("./lib/recovery");
const { detectOpenCodeMajorVersion } = require("../../shared/opencode-version");
const { resolveCLIAuth, createSanitizer } = require("../../shared/cli-provider-auth");

module.exports = function (RED) {
  "use strict";

  function AgentServerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.hostname = config.hostname || "127.0.0.1";
    node.opencodeBinary = config.opencodeBinary || "";
    node.apiVersionMode = config.apiVersionMode || "auto";
    let detectedApiVersion;
    let versionDetectionWarningSent = false;
    const sanitizers = new Map();
    let closing = false;
    let starting = 0;
    const sanitize = (value) => {
      for (const redact of sanitizers.keys()) value = redact(value);
      return value;
    };
    function cliAuth(model = "") {
      return resolveCLIAuth(RED, {
        authMode: config.authMode || "default",
        modelProvider: config.modelProvider,
        agent:
          config.authMode && config.authMode !== "default"
            ? `opencode-${apiVersion()}`
            : "opencode",
        model,
      });
    }

    node.operation = config.operation || "message";

    // Typed-input override of the serverName reported on outgoing/event
    // messages (see emitEvent below). Same typed-input pattern as every
    // other overridable field: blank/unresolved falls back to node.name.
    node.serverName = config.serverName !== undefined ? config.serverName : "";
    node.serverNameType = config.serverNameType || "str";

    node.sessionIdProp = config.sessionIdProp !== undefined ? config.sessionIdProp : "sessionID";
    node.sessionIdPropType = config.sessionIdPropType || "msg";

    node.promptProp = config.promptProp !== undefined ? config.promptProp : "payload";
    node.promptPropType = config.promptPropType || "msg";

    node.model = config.model || "";
    node.modelType = config.modelType || "str";

    node.startupTimeoutMs = Number(config.startupTimeoutMs) || 15000;
    node.requestTimeoutMs = Number(config.requestTimeoutMs) || 120000;

    const maxInstancesNum = parseInt(config.maxInstances, 10);
    // 0 (or invalid/blank) means unlimited -- not everyone needs a cap,
    // and 0 reads more naturally as "no limit" than as "allow zero".
    node.maxInstances =
      Number.isFinite(maxInstancesNum) && maxInstancesNum > 0 ? maxInstancesNum : 0;

    node.authUsername = config.authUsername || "";
    node.authPassword = config.authPassword || "";

    node.runtime = config.runtime || "direct";
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

    // Resolved once at construction time, same pattern as the `agent`
    // node -- these settings don't change without a redeploy.
    node.resolvedSrtSettingsPath = undefined;
    node.srtTempSettingsFile = undefined;
    node.srtSettingsError = undefined;

    if (node.runtime === "srt") {
      if (node.srtSettingsMode === "inline") {
        try {
          node.resolvedSrtSettingsPath = writeInlineSettingsFile(
            node.id,
            {
              allowedDomains: node.srtAllowedDomains,
              allowedWriteDirs: node.srtAllowedWriteDirs,
              strictAllowlist: node.srtStrictAllowlist,
              advancedJson: node.srtAdvancedJson,
            },
            "agent-server-srt-settings",
          );
          node.srtTempSettingsFile = node.resolvedSrtSettingsPath;
        } catch (err) {
          node.srtSettingsError = `invalid inline SRT settings JSON: ${err.message}`;
          node.error(`agent-server: ${node.srtSettingsError}`);
          node.status({ fill: "red", shape: "ring", text: "bad srt settings" });
        }
      } else {
        node.resolvedSrtSettingsPath = node.srtSettingsPath || undefined;
      }
    }

    node.registry = new InstanceRegistry();

    function updateStatus() {
      node.status(computeNodeStatus(node.registry.summary()));
    }

    // Envelope shared by every message on output 2 -- same shape/intent
    // as the `agent` node's lifecycle envelope (topic correlation + live
    // counts + timestamp), just counting daemons/sessions instead of
    // executions. This is what a downstream ui-table/context-aggregator
    // uses to build a "what has been running" history.
    function emitEvent(sessionID, type, msg, redact = (value) => value) {
      const summary = node.registry.summary();
      node.send(
        redact(
          sanitize([
            null,
            {
              _msgid: msg && msg._msgid,
              topic: msg && msg.topic,
              payload: { type },
              sessionID,
              serverId: node.id,
              serverName: resolveServerName(msg),
              active: summary.busy,
              tracked: summary.total,
              timestamp: Date.now(),
            },
          ]),
        ),
      );
    }

    function resolveTyped(prop, type, msg, fallback) {
      if (prop === "") return fallback;
      try {
        const value = RED.util.evaluateNodeProperty(prop, type, node, msg);
        return value === undefined || value === null || value === "" ? fallback : value;
      } catch (err) {
        throw new Error(`invalid ${type} property "${prop}": ${err.message}`, { cause: err });
      }
    }

    // Per-message resolution of the reported serverName: the typed-input
    // serverName/serverNameType field (e.g. msg.serverName) if configured
    // and present, else node.name -- same fallback every other typed-input
    // field has when blank/unresolved. Tolerates a missing msg (emitEvent
    // is sometimes called without one, e.g. from spawnNewInstance's own
    // internal bookkeeping) by resolving against an empty object.
    function resolveServerName(msg) {
      return resolveTyped(node.serverName, node.serverNameType, msg || {}, node.name);
    }

    function apiVersion() {
      if (node.apiVersionMode === "v1" || node.apiVersionMode === "v2") return node.apiVersionMode;
      if (detectedApiVersion) return detectedApiVersion;
      try {
        detectedApiVersion =
          detectOpenCodeMajorVersion({
            binary: node.opencodeBinary || "opencode",
            execFileSync,
          }) >= 2
            ? "v2"
            : "v1";
      } catch (err) {
        if (!versionDetectionWarningSent) {
          versionDetectionWarningSent = true;
          node.warn(`could not detect OpenCode CLI version; using v1 server API: ${err.message}`);
        }
      }
      return detectedApiVersion || "v1";
    }

    // Extracts the assistant's text reply the same way the `agent`
    // node's OpenCodeAdapter does: join every text-type part.
    function extractText(messageResponse) {
      const parts = (messageResponse && (messageResponse.parts || messageResponse.content)) || [];
      return parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim();
    }

    // Spawns a brand-new daemon + session, registers it, and resolves
    // with { sessionID, baseUrl }. Cleans up (kills the half-started
    // process) and rejects on any failure along the way -- callers
    // never have to clean up a partially-started daemon themselves.
    async function spawnNewInstance(msg, model) {
      if (node.maxInstances > 0 && node.registry.size() + starting >= node.maxInstances) {
        throw new Error(
          `agent-server: max instances (${node.maxInstances}) reached, cannot spawn a new daemon`,
        );
      }
      starting += 1;
      try {
        return await startInstance(msg, model);
      } finally {
        starting -= 1;
      }
    }

    async function startInstance(msg, model) {
      const port = await findFreePort(node.hostname);
      if (closing) throw new Error("agent-server: node is closing");
      const baseUrl = `http://${node.hostname}:${port}`;
      const version = apiVersion();
      const auth = createDaemonAuth(version, {
        username: node.authUsername,
        password: node.authPassword,
      });

      const providerAuth = cliAuth(model ? `${model.providerID}/${model.modelID}` : "");
      const redactAuth = createSanitizer([auth.password]);
      const localSanitize = (value) => redactAuth(providerAuth.sanitize(value));
      const owner = { child: undefined, sessionID: undefined, stopping: false };
      sanitizers.set(localSanitize, owner);
      const env = providerAuth.env;
      if (version === "v2") {
        env.OPENCODE_PASSWORD = auth.password;
        env.OPENCODE_SERVER_USERNAME = auth.username;
        env.OPENCODE_SERVER_PASSWORD = auth.password;
      } else if (node.authUsername || node.authPassword) {
        env.OPENCODE_SERVER_PASSWORD = node.authPassword;
        if (node.authUsername) env.OPENCODE_SERVER_USERNAME = node.authUsername;
      }

      try {
        const { child, diagnostics } = spawnDaemon({
          binary: node.opencodeBinary || undefined,
          hostname: node.hostname,
          port,
          env,
          sanitize: localSanitize,
          srt: {
            enabled: node.runtime === "srt",
            binary: node.srtBinary || undefined,
            settingsPath: node.resolvedSrtSettingsPath,
          },
        });
        owner.child = child;
        child.once("exit", () => {
          // Pending startup and intentional shutdown sanitize their final output first.
          if (!owner.sessionID || owner.stopping) return;
          const busy = node.registry.get(owner.sessionID)?.busy;
          node.registry.delete(owner.sessionID);
          if (!busy && !owner.failureReported) {
            node.error("agent-server: owned daemon exited unexpectedly");
            emitEvent(owner.sessionID, "failed", msg, localSanitize);
          }
          sanitizers.delete(localSanitize);
          updateStatus();
        });
        await waitForHealthy(baseUrl, {
          timeoutMs: node.startupTimeoutMs,
          diagnostics,
          apiVersion: version,
          ...auth,
        });
        if (closing || child.exitCode !== null || child.signalCode !== null) {
          throw new Error("agent-server: daemon stopped during startup");
        }

        const session =
          version === "v2"
            ? await apiV2.createSession(baseUrl, (msg && msg.topic) || "agent-server", {
                timeoutMs: node.requestTimeoutMs,
                ...auth,
              })
            : await request(`${baseUrl}/session`, {
                method: "POST",
                body: { title: (msg && msg.topic) || "agent-server" },
                timeoutMs: node.requestTimeoutMs,
                ...auth,
              });
        if (closing || child.exitCode !== null || child.signalCode !== null) {
          throw new Error("agent-server: daemon stopped during session creation");
        }

        const sessionID = session.id;
        owner.sessionID = sessionID;
        node.registry.register(sessionID, {
          child,
          host: node.hostname,
          port,
          baseUrl,
          apiVersion: version,
          auth,
          sanitize: localSanitize,
        });
        emitEvent(sessionID, "spawned", msg);
        updateStatus();
        return { sessionID, baseUrl };
      } catch (err) {
        owner.stopping = true;
        if (owner.sessionID) node.registry.delete(owner.sessionID);
        let failure = new Error(localSanitize(sanitize(err.message || String(err))));
        try {
          await killDaemon(owner.child);
        } catch (cleanupError) {
          failure = new Error(
            localSanitize(sanitize(cleanupError.message || String(cleanupError))),
          );
        } finally {
          sanitizers.delete(localSanitize);
        }
        throw failure;
      }
    }

    // Shared by both the "spawn new" and "reuse existing" paths.
    async function sendMessage(sessionID, baseUrl, prompt, model, msg, send, done) {
      const record = node.registry.get(sessionID);
      const owner = sanitizers.get(record.sanitize);
      if (owner) owner.failureReported = false;
      const localSanitize = record.sanitize || sanitize;
      const originalSend = send;
      const originalDone = done;
      send = (value) => originalSend(localSanitize(value));
      done = (error) => originalDone(error ? new Error(localSanitize(error.message)) : undefined);
      node.registry.setBusy(sessionID, true);
      emitEvent(sessionID, "running", msg, localSanitize);
      updateStatus();

      const auth = record.auth || {};
      // process.hrtime.bigint() rather than Date.now() for the
      // duration measurement specifically: it's monotonic, so it
      // can't ever go negative from a wall-clock adjustment mid-call
      // (observed once in this sandbox's WSL2 VM). timestamp fields
      // elsewhere deliberately stay Date.now() -- those are for
      // human-readable/correlatable wall-clock history, not duration.
      const startedAtNs = process.hrtime.bigint();
      const promptID = `msg_${randomUUID()}`;
      let submitted = false;
      try {
        const body = {
          agent: msg.agent || "build",
          parts: [{ type: "text", text: String(prompt) }],
        };
        if (model) body.model = model;
        const remainingMs = () => {
          const remaining =
            node.requestTimeoutMs - Number((process.hrtime.bigint() - startedAtNs) / 1000000n);
          if (remaining <= 0) throw new Error("v2 prompt request deadline exceeded");
          return remaining;
        };
        const response =
          record.apiVersion === "v2"
            ? await (async () => {
                const deadlineOptions = () => ({ timeoutMs: remainingMs(), ...auth });
                await apiV2.switchAgent(baseUrl, sessionID, body.agent, deadlineOptions());
                if (model) {
                  await apiV2.switchModel(baseUrl, sessionID, model, deadlineOptions());
                }
                submitted = true;
                const admission = await apiV2.prompt(baseUrl, sessionID, prompt, {
                  ...deadlineOptions(),
                  promptID,
                });
                if (admission?.id !== promptID) {
                  throw new Error("v2 prompt admission returned an unexpected message ID");
                }
                return apiV2.waitForCompletion(baseUrl, sessionID, promptID, {
                  ...deadlineOptions(),
                });
              })()
            : await request(`${baseUrl}/session/${sessionID}/message`, {
                method: "POST",
                body,
                timeoutMs: node.requestTimeoutMs,
                ...auth,
              });

        apiV2.assertMessageSuccess(response);
        node.registry.setBusy(sessionID, false);
        const durationMs = Number((process.hrtime.bigint() - startedAtNs) / 1000000n);
        const resultMsg = Object.assign({}, msg, {
          payload: extractText(response),
          sessionID,
          serverId: node.id,
          serverName: resolveServerName(msg),
          agentServer: {
            sessionID,
            host: record && record.host,
            port: record && record.port,
            durationMs,
          },
        });
        send([resultMsg, null]);
        emitEvent(sessionID, "completed", msg, localSanitize);
        updateStatus();
        done();
      } catch (err) {
        // A broken transport can reject before the child exit event arrives.
        // The input path reports this owned failure; exit must not duplicate it.
        if (owner) owner.failureReported = true;
        let failure = err;
        if (submitted && node.registry.get(sessionID) === record) {
          const settled = await settleTurn(baseUrl, sessionID, promptID, {
            timeoutMs: node.requestTimeoutMs,
            ...auth,
          });
          if (!settled && node.registry.get(sessionID) === record) {
            const owner = sanitizers.get(record.sanitize);
            if (owner) owner.stopping = true;
            node.registry.delete(sessionID);
            try {
              await killDaemon(record.child);
            } catch (cleanupError) {
              failure = cleanupError;
            } finally {
              sanitizers.delete(record.sanitize);
            }
          }
        }
        node.registry.setBusy(sessionID, false);
        emitEvent(sessionID, "failed", msg, localSanitize);
        updateStatus();
        done(
          new Error(`agent-server: message to session "${sessionID}" failed: ${failure.message}`),
        );
      }
    }

    function handleMessageOperation(msg, send, done) {
      let sessionID;
      try {
        sessionID = resolveTyped(node.sessionIdProp, node.sessionIdPropType, msg, undefined);
      } catch (err) {
        done(err);
        return;
      }

      let prompt;
      try {
        prompt = resolveTyped(node.promptProp, node.promptPropType, msg, undefined);
      } catch (err) {
        done(err);
        return;
      }
      if (prompt === undefined || prompt === null || String(prompt).trim() === "") {
        done(
          new Error(
            "agent-server: no prompt (msg.payload or the configured Prompt field is empty)",
          ),
        );
        return;
      }

      let model;
      try {
        const selected = resolveTyped(node.model, node.modelType, msg, "");
        model = parseModel(cliAuth(selected).model);
      } catch (err) {
        done(new Error(`agent-server: ${err.message}`));
        return;
      }

      if (sessionID) {
        // Foreign sessionID -- not tracked by this node instance --
        // is always an error, never a fallback spawn/resume.
        if (!node.registry.has(sessionID)) {
          done(
            new Error(
              `agent-server: unknown sessionID "${sessionID}" (not tracked by this node instance)`,
            ),
          );
          return;
        }
        const record = node.registry.get(sessionID);
        if (record.busy) {
          done(new Error(`agent-server: session "${sessionID}" is already processing a message`));
          return;
        }
        sendMessage(sessionID, record.baseUrl, prompt, model, msg, send, done);
        return;
      }

      spawnNewInstance(msg, model)
        .then(({ sessionID: newSessionID, baseUrl }) =>
          sendMessage(newSessionID, baseUrl, prompt, model, msg, send, done),
        )
        .catch((err) => {
          updateStatus();
          done(err);
        });
    }

    function handleStatusOperation(msg, send, done) {
      let sessionID;
      try {
        sessionID = resolveTyped(node.sessionIdProp, node.sessionIdPropType, msg, undefined);
      } catch (err) {
        done(err);
        return;
      }

      if (!sessionID) {
        // Aggregate across every daemon this node instance is
        // tracking -- purely local, no network calls.
        send([
          Object.assign({}, msg, {
            payload: node.registry.summary(),
            serverId: node.id,
            serverName: resolveServerName(msg),
          }),
          null,
        ]);
        done();
        return;
      }

      if (!node.registry.has(sessionID)) {
        done(
          new Error(
            `agent-server: unknown sessionID "${sessionID}" (not tracked by this node instance)`,
          ),
        );
        return;
      }

      const record = node.registry.get(sessionID);
      send([
        Object.assign({}, msg, {
          payload: {
            sessionID,
            busy: record.busy,
            host: record.host,
            port: record.port,
            startedAt: record.startedAt,
            lastUsed: record.lastUsed,
          },
          serverId: node.id,
          serverName: resolveServerName(msg),
        }),
        null,
      ]);
      done();
    }

    function handleAbortOperation(msg, send, done) {
      let sessionID;
      try {
        sessionID = resolveTyped(node.sessionIdProp, node.sessionIdPropType, msg, undefined);
      } catch (err) {
        done(err);
        return;
      }
      if (!sessionID || !node.registry.has(sessionID)) {
        done(
          new Error(
            `agent-server: unknown sessionID "${sessionID}" (not tracked by this node instance)`,
          ),
        );
        return;
      }

      const record = node.registry.get(sessionID);
      const operation =
        record.apiVersion === "v2"
          ? apiV2.abort(record.baseUrl, sessionID, {
              timeoutMs: node.requestTimeoutMs,
              ...(record.auth || {}),
            })
          : request(`${record.baseUrl}/session/${sessionID}/abort`, {
              method: "POST",
              timeoutMs: node.requestTimeoutMs,
              ...(record.auth || {}),
            });
      operation
        .then(() => {
          if (record.apiVersion !== "v2") node.registry.setBusy(sessionID, false);
          updateStatus();
          send([
            Object.assign({}, msg, {
              payload: true,
              sessionID,
              serverId: node.id,
              serverName: resolveServerName(msg),
            }),
            null,
          ]);
          done();
        })
        .catch((err) => done(new Error(`agent-server: abort failed: ${err.message}`)));
    }

    function handleHistoryOperation(msg, send, done) {
      let sessionID;
      try {
        sessionID = resolveTyped(node.sessionIdProp, node.sessionIdPropType, msg, undefined);
      } catch (err) {
        done(err);
        return;
      }
      if (!sessionID || !node.registry.has(sessionID)) {
        done(
          new Error(
            `agent-server: unknown sessionID "${sessionID}" (not tracked by this node instance)`,
          ),
        );
        return;
      }

      const record = node.registry.get(sessionID);
      const historyRequest =
        record.apiVersion === "v2"
          ? apiV2.messages(record.baseUrl, sessionID, {
              timeoutMs: node.requestTimeoutMs,
              ...(record.auth || {}),
            })
          : request(`${record.baseUrl}/session/${sessionID}/message`, {
              timeoutMs: node.requestTimeoutMs,
              ...(record.auth || {}),
            });
      historyRequest
        .then((history) => {
          send([
            Object.assign({}, msg, {
              payload: history,
              sessionID,
              serverId: node.id,
              serverName: resolveServerName(msg),
            }),
            null,
          ]);
          done();
        })
        .catch((err) => done(new Error(`agent-server: history fetch failed: ${err.message}`)));
    }

    // Kills the daemon process itself, unlike `abort` (which only
    // HTTP-cancels the in-flight message and leaves the daemon running,
    // reusable for a later message). After this, the sessionID is no
    // longer tracked -- a later message with this sessionID is a foreign/
    // unknown id, same as if it had never been spawned.
    function handleTerminateOperation(msg, send, done) {
      let sessionID;
      try {
        sessionID = resolveTyped(node.sessionIdProp, node.sessionIdPropType, msg, undefined);
      } catch (err) {
        done(err);
        return;
      }
      if (!sessionID || !node.registry.has(sessionID)) {
        done(
          new Error(
            `agent-server: unknown sessionID "${sessionID}" (not tracked by this node instance)`,
          ),
        );
        return;
      }

      const record = node.registry.get(sessionID);
      const owner = sanitizers.get(record.sanitize);
      if (owner) owner.stopping = true;
      node.registry.delete(sessionID);
      killDaemon(record.child)
        .then(() => {
          try {
            emitEvent(sessionID, "terminated", msg, record.sanitize);
            updateStatus();
            send([
              Object.assign({}, msg, {
                payload: true,
                sessionID,
                serverId: node.id,
                serverName: resolveServerName(msg),
              }),
              null,
            ]);
            done();
          } finally {
            sanitizers.delete(record.sanitize);
          }
        })
        .catch((err) => {
          done(new Error(`agent-server: terminate failed: ${err.message}`));
          sanitizers.delete(record.sanitize);
        });
    }

    const VALID_OPERATIONS = ["message", "status", "abort", "history", "terminate"];

    node.on("input", function (msg, send, done) {
      const originalSend = send;
      const originalDone = done;
      let sessionID;
      try {
        sessionID = resolveTyped(node.sessionIdProp, node.sessionIdPropType, msg, undefined);
      } catch (err) {
        originalDone(new Error(sanitize(err.message)));
        return;
      }
      const localSanitize = node.registry.get(sessionID)?.sanitize || ((value) => value);
      send = (value) => originalSend(localSanitize(sanitize(value)));
      done = (error) =>
        originalDone(
          error ? new Error(localSanitize(sanitize(error.message || String(error)))) : undefined,
        );
      if (node.srtSettingsError) {
        done(new Error(`agent-server: ${node.srtSettingsError}`));
        return;
      }

      // Optional per-message override of the deploy-time Max instances
      // field, applied before spawnNewInstance()'s guard clause reads it
      // -- no redeploy needed. 0 stays "unlimited" (same as the
      // constructor's semantics above); negative/non-numeric values are
      // ignored. Lowering the limit below the current registry size
      // never evicts already-spawned daemons -- it only blocks *future*
      // spawns until the count naturally drops back under the new cap.
      if (msg.maxInstances !== undefined) {
        const n = Number(msg.maxInstances);
        if (Number.isFinite(n) && n >= 0) node.maxInstances = Math.floor(n);
      }

      // msg.operation can override the configured default for this one
      // trigger. This matters because each node instance's registry is
      // private (per-node-instance scoping, same as the `agent` node's
      // active/queued counts) -- a *separate* node configured with
      // operation 'status' would only ever see its own (always empty)
      // registry, never another node's spawned daemons. Overriding lets
      // the same node instance that does the spawning also be queried
      // for its own status/history/abort on demand.
      const operation = VALID_OPERATIONS.includes(msg.operation) ? msg.operation : node.operation;

      switch (operation) {
        case "status":
          handleStatusOperation(msg, send, done);
          return;
        case "abort":
          handleAbortOperation(msg, send, done);
          return;
        case "history":
          handleHistoryOperation(msg, send, done);
          return;
        case "terminate":
          handleTerminateOperation(msg, send, done);
          return;
        case "message":
        default:
          handleMessageOperation(msg, send, done);
          return;
      }
    });

    node.on("close", function (done) {
      closing = true;
      const entries = Array.from(sanitizers.entries());
      Promise.all(
        entries.map(([redact, owner]) => {
          const sessionID = owner.sessionID;
          owner.stopping = true;
          node.registry.delete(sessionID);
          return killDaemon(owner.child)
            .then(() => {
              if (sessionID) emitEvent(sessionID, "closed", {}, redact);
            })
            .finally(() => sanitizers.delete(redact));
        }),
      )
        .then(() => {
          if (node.srtTempSettingsFile) {
            fs.unlink(node.srtTempSettingsFile, () => {});
          }
          node.status({});
          done();
        })
        .catch((error) => {
          node.error(new Error(sanitize(`agent-server: close failed: ${error.message}`)));
          done(error);
        });
    });
  }

  RED.nodes.registerType("agent-server", AgentServerNode);
};
