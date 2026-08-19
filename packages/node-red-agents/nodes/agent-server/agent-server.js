"use strict";

const fs = require("fs");
const { findFreePort } = require("./lib/port");
const { InstanceRegistry } = require("./lib/registry");
const { spawnDaemon, waitForHealthy, killDaemon } = require("./lib/daemon");
const { computeNodeStatus } = require("./lib/status");
const { writeInlineSettingsFile } = require("../../shared/srt-settings");
const { request } = require("./lib/http");
const { parseModel } = require("./lib/model");

module.exports = function (RED) {
  "use strict";

  function AgentServerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.hostname = config.hostname || "127.0.0.1";
    node.opencodeBinary = config.opencodeBinary || "";

    node.operation = config.operation || "message";

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
    function emitEvent(sessionID, type, msg) {
      const summary = node.registry.summary();
      node.send([
        null,
        {
          _msgid: msg && msg._msgid,
          topic: msg && msg.topic,
          payload: { type },
          sessionID,
          serverId: node.id,
          active: summary.busy,
          tracked: summary.total,
          timestamp: Date.now(),
        },
      ]);
    }

    function resolveTyped(prop, type, msg, fallback) {
      if (prop === "") return fallback;
      try {
        const value = RED.util.evaluateNodeProperty(prop, type, node, msg);
        return value === undefined || value === null || value === "" ? fallback : value;
      } catch (err) {
        throw new Error(`invalid ${type} property "${prop}": ${err.message}`);
      }
    }

    function authOptions() {
      return node.authUsername || node.authPassword
        ? { username: node.authUsername, password: node.authPassword }
        : {};
    }

    // Extracts the assistant's text reply the same way the `agent`
    // node's OpenCodeAdapter does: join every text-type part.
    function extractText(messageResponse) {
      const parts = (messageResponse && messageResponse.parts) || [];
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
    async function spawnNewInstance(msg) {
      if (node.maxInstances > 0 && node.registry.size() >= node.maxInstances) {
        throw new Error(
          `agent-server: max instances (${node.maxInstances}) reached, cannot spawn a new daemon`,
        );
      }

      const port = await findFreePort(node.hostname);
      const baseUrl = `http://${node.hostname}:${port}`;
      const auth = authOptions();

      const env = Object.assign({}, process.env);
      if (node.authUsername || node.authPassword) {
        env.OPENCODE_SERVER_PASSWORD = node.authPassword;
        if (node.authUsername) env.OPENCODE_SERVER_USERNAME = node.authUsername;
      }

      const { child, diagnostics } = spawnDaemon({
        binary: node.opencodeBinary || undefined,
        hostname: node.hostname,
        port,
        env,
        srt: {
          enabled: node.runtime === "srt",
          binary: node.srtBinary || undefined,
          settingsPath: node.resolvedSrtSettingsPath,
        },
      });

      try {
        await waitForHealthy(baseUrl, {
          timeoutMs: node.startupTimeoutMs,
          diagnostics,
          ...auth,
        });
      } catch (err) {
        await killDaemon(child);
        throw err;
      }

      let session;
      try {
        session = await request(`${baseUrl}/session`, {
          method: "POST",
          body: { title: (msg && msg.topic) || "agent-server" },
          timeoutMs: node.requestTimeoutMs,
          ...auth,
        });
      } catch (err) {
        await killDaemon(child);
        throw err;
      }

      const sessionID = session.id;
      node.registry.register(sessionID, { child, host: node.hostname, port, baseUrl });
      emitEvent(sessionID, "spawned", msg);
      updateStatus();
      return { sessionID, baseUrl };
    }

    // Shared by both the "spawn new" and "reuse existing" paths.
    async function sendMessage(sessionID, baseUrl, prompt, model, msg, send, done) {
      node.registry.setBusy(sessionID, true);
      emitEvent(sessionID, "running", msg);
      updateStatus();

      const auth = authOptions();
      // process.hrtime.bigint() rather than Date.now() for the
      // duration measurement specifically: it's monotonic, so it
      // can't ever go negative from a wall-clock adjustment mid-call
      // (observed once in this sandbox's WSL2 VM). timestamp fields
      // elsewhere deliberately stay Date.now() -- those are for
      // human-readable/correlatable wall-clock history, not duration.
      const startedAtNs = process.hrtime.bigint();
      try {
        const body = {
          agent: msg.agent || "build",
          parts: [{ type: "text", text: String(prompt) }],
        };
        if (model) body.model = model;
        const response = await request(`${baseUrl}/session/${sessionID}/message`, {
          method: "POST",
          body,
          timeoutMs: node.requestTimeoutMs,
          ...auth,
        });

        node.registry.setBusy(sessionID, false);
        const record = node.registry.get(sessionID);
        const durationMs = Number((process.hrtime.bigint() - startedAtNs) / 1000000n);
        const resultMsg = Object.assign({}, msg, {
          payload: extractText(response),
          sessionID,
          serverId: node.id,
          agentServer: {
            sessionID,
            host: record && record.host,
            port: record && record.port,
            durationMs,
          },
        });
        send([resultMsg, null]);
        emitEvent(sessionID, "completed", msg);
        updateStatus();
        done();
      } catch (err) {
        node.registry.setBusy(sessionID, false);
        emitEvent(sessionID, "failed", msg);
        updateStatus();
        done(new Error(`agent-server: message to session "${sessionID}" failed: ${err.message}`));
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
        model = parseModel(resolveTyped(node.model, node.modelType, msg, ""));
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

      spawnNewInstance(msg)
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
        send([Object.assign({}, msg, { payload: node.registry.summary(), serverId: node.id }), null]);
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
      request(`${record.baseUrl}/session/${sessionID}/abort`, {
        method: "POST",
        timeoutMs: node.requestTimeoutMs,
        ...authOptions(),
      })
        .then(() => {
          node.registry.setBusy(sessionID, false);
          updateStatus();
          send([Object.assign({}, msg, { payload: true, sessionID, serverId: node.id }), null]);
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
      request(`${record.baseUrl}/session/${sessionID}/message`, {
        timeoutMs: node.requestTimeoutMs,
        ...authOptions(),
      })
        .then((history) => {
          send([Object.assign({}, msg, { payload: history, sessionID, serverId: node.id }), null]);
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
      node.registry.delete(sessionID);
      killDaemon(record.child)
        .then(() => {
          emitEvent(sessionID, "terminated", msg);
          updateStatus();
          send([Object.assign({}, msg, { payload: true, sessionID, serverId: node.id }), null]);
          done();
        })
        .catch((err) => done(new Error(`agent-server: terminate failed: ${err.message}`)));
    }

    const VALID_OPERATIONS = ["message", "status", "abort", "history", "terminate"];

    node.on("input", function (msg, send, done) {
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
      const entries = Array.from(node.registry.list());
      Promise.all(
        entries.map((sessionID) => {
          const record = node.registry.get(sessionID);
          node.registry.delete(sessionID);
          return killDaemon(record.child).then(() => {
            emitEvent(sessionID, "closed", {});
          });
        }),
      ).then(() => {
        if (node.srtTempSettingsFile) {
          fs.unlink(node.srtTempSettingsFile, () => {});
        }
        node.status({});
        done();
      });
    });
  }

  RED.nodes.registerType("agent-server", AgentServerNode);
};
