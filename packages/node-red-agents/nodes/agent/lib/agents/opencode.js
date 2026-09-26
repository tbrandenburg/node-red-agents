"use strict";

const fs = require("fs");
const { AgentAdapter } = require("./base");
const { toOpenCodeMcp } = require("../mcp/normalize");
const { assertModelFormat } = require("../../../../shared/model-format");
const { detectOpenCodeMajorVersion } = require("../../../../shared/opencode-version");

const detectedVersions = new Map();

// Maps opencode's real `--format json` event stream types (verified against
// packages/opencode/src/cli/cmd/run.ts) onto the Agent node's generic event
// vocabulary (spec section "Event output").
const TYPE_MAP = {
  step_start: "started",
  step_finish: "progress",
  tool_use: "tool",
  text: "agent",
  reasoning: "agent",
  error: "failed",
};

class OpenCodeAdapter extends AgentAdapter {
  constructor({ fixedVersion } = {}) {
    super();
    // 1 | 2 | undefined (undefined = auto-detect at runtime, unchanged
    // default behavior). Set by the "opencode-v1"/"opencode-v2" agent
    // dropdown variants (issue #54); "opencode" leaves this undefined.
    this.fixedVersion = fixedVersion;
  }

  validate(resolved) {
    assertModelFormat(resolved.model);
    const version = this.resolveVersion(resolved);

    if (version === 2 && resolved.effort && !resolved.model) {
      throw new Error("OpenCode v2 effort requires an explicit model (provider/model)");
    }

    if (resolved.cwd) {
      let stat;
      try {
        stat = fs.statSync(resolved.cwd);
      } catch (err) {
        throw new Error(`cwd does not exist: ${resolved.cwd}`, { cause: err });
      }
      if (!stat.isDirectory()) {
        throw new Error(`cwd is not a directory: ${resolved.cwd}`);
      }
    }

    if (resolved.invocation === "prompt") {
      if (!resolved.prompt || !String(resolved.prompt).trim()) {
        throw new Error(
          "prompt invocation requires a non-empty prompt (msg.payload or the Prompt field)",
        );
      }
    } else if (resolved.invocation === "skill" || resolved.invocation === "command") {
      if (version === 2) {
        throw new Error(
          "skill/command invocation is not yet supported for OpenCode v2 (see CAPABILITIES.commandInvocation)",
        );
      }
      if (!resolved.invocationName || !String(resolved.invocationName).trim()) {
        throw new Error(`${resolved.invocation} invocation requires a non-empty name`);
      }
    } else {
      throw new Error(`unknown invocation mode: ${resolved.invocation}`);
    }

    for (const server of resolved.mcpServers || []) {
      if (!server || !server.name) {
        throw new Error("mcpServers entries require a name");
      }
      if (server.type === "remote" && !server.url) {
        throw new Error(`mcp server "${server.name}" (remote) requires a url`);
      }
      if (server.type === "local" && !server.command) {
        throw new Error(`mcp server "${server.name}" (local) requires a command`);
      }
      if (server.type !== "remote" && server.type !== "local") {
        throw new Error(`mcp server "${server.name}" has unknown type: ${server.type}`);
      }
    }
  }

  buildExecution(resolved) {
    const version = this.resolveVersion(resolved);
    if (version === 2 && resolved.invocation !== "prompt") {
      throw new Error(
        "skill/command invocation is not yet supported for OpenCode v2 (see CAPABILITIES.commandInvocation)",
      );
    }
    const args = ["run", "--format", "json"];

    // Resuming an existing session (opencode run -s <id> ...) rather
    // than always starting a new one -- verified against `opencode run
    // --help`: -s/--session takes the id to continue.
    if (resolved.sessionID) args.push("--session", String(resolved.sessionID));

    if (resolved.cwd && version === 1) args.push("--dir", resolved.cwd);
    const model =
      resolved.model && version === 2 && resolved.effort
        ? `${resolved.model}#${resolved.effort}`
        : resolved.model;
    if (model) args.push("--model", model);
    if (resolved.auto) args.push("--auto");

    // --variant <effort> -- verified working against a real `opencode run`
    // invocation (see CAPABILITIES.effortControl below). systemPrompt has
    // no verified CLI flag for this adapter (CAPABILITIES.systemPromptControl
    // is false), so it's never forwarded here -- agent.js already warns and
    // drops it before this is even called.
    if (version === 1 && OpenCodeAdapter.CAPABILITIES.effortControl && resolved.effort) {
      args.push("--variant", resolved.effort);
    }

    // Skill and Command/Template invocation share the same underlying
    // opencode mechanism: skills are registered internally as commands
    // (source:"skill"), so `--command <name>` handles both -- verified
    // against packages/opencode/src/command/index.ts.
    if (resolved.invocation === "skill" || resolved.invocation === "command") {
      args.push("--command", String(resolved.invocationName));
      args.push(resolved.args !== undefined && resolved.args !== null ? String(resolved.args) : "");
    } else {
      args.push(String(resolved.prompt));
    }

    const env = {};
    const opencodeConfig = {};
    if (Array.isArray(resolved.mcpServers) && resolved.mcpServers.length > 0) {
      const mcp = toOpenCodeMcp(resolved.mcpServers);
      opencodeConfig.mcp =
        version === 2
          ? {
              servers: Object.fromEntries(
                Object.entries(mcp).map(([name, server]) => {
                  const { enabled, ...settings } = server;
                  return [name, Object.assign(settings, { disabled: enabled === false })];
                }),
              ),
            }
          : mcp;
    }

    // allowed_tools/denied_tools (issue #25): opencode has no direct
    // `--tools` flag (unlike pi.js), but its config schema supports a
    // per-agent `tools: { <name>: true|false }` map (verified against
    // opencode's own agent docs). Rather than inventing a new delivery
    // mechanism, this reuses the exact same OPENCODE_CONFIG_CONTENT env
    // var already used for mcpServers above -- an ephemeral, per-process
    // config the child process reads and that vanishes with it, with
    // nothing left on disk to clean up (unlike the srt inline-settings
    // temp file, which outlives the process and does need explicit
    // unlinking). A fixed, unique-per-node agent name is defined as
    // "primary" (required for `opencode run --agent <name>` to accept it)
    // and selected via --agent.
    const hasAllow = Array.isArray(resolved.allowedTools) && resolved.allowedTools.length > 0;
    const hasDeny = Array.isArray(resolved.deniedTools) && resolved.deniedTools.length > 0;
    if (OpenCodeAdapter.CAPABILITIES.toolRestrictions && (hasAllow || hasDeny)) {
      const agentName = "node-red-agent-tools";
      if (version === 2) {
        const permissions = [];
        const v2Action = (name) => ({ bash: "shell", write: "edit", patch: "edit" })[name] || name;
        for (const name of resolved.deniedTools || []) {
          permissions.push({
            action: v2Action(name),
            resource: "*",
            effect: "deny",
          });
        }
        for (const name of resolved.allowedTools || []) {
          permissions.push({
            action: v2Action(name),
            resource: "*",
            effect: "allow",
          });
        }
        opencodeConfig.agents = { [agentName]: { mode: "primary", permissions } };
      } else {
        const tools = {};
        for (const name of resolved.deniedTools || []) tools[name] = false;
        for (const name of resolved.allowedTools || []) tools[name] = true;
        opencodeConfig.agent = { [agentName]: { mode: "primary", tools } };
      }
      args.push("--agent", agentName);
    }

    if (Object.keys(opencodeConfig).length > 0) {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(opencodeConfig);
      // v2's default shared service owns configuration and won't see this
      // per-process environment value. Isolate only executions that need
      // ephemeral MCP/permission config so the child loads its own config.
      if (version === 2) args.splice(1, 0, "--standalone");
    }

    return { command: "opencode", args, env };
  }

  resolveVersion(resolved) {
    if (this.fixedVersion === 1 || this.fixedVersion === 2) return this.fixedVersion;
    // Deprecated back-compat fallback (issue #54): only reachable via
    // hand-edited/scripted flow JSON that still sets this field directly --
    // there is no UI path to it anymore. Remove after node-red-agents@0.6.0.
    if (resolved.openCodeVersionMode === "v1") return 1;
    if (resolved.openCodeVersionMode === "v2") return 2;
    const binary = "opencode";
    if (detectedVersions.has(binary)) return detectedVersions.get(binary);
    try {
      const version = detectOpenCodeMajorVersion({ binary });
      detectedVersions.set(binary, version);
      return version;
    } catch (err) {
      detectedVersions.set(binary, 1);
      if (typeof resolved.onWarning === "function") {
        resolved.onWarning(
          `could not detect OpenCode CLI version; using v1 behavior: ${err.message}`,
        );
      }
      return 1;
    }
  }

  parseEvent(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch (err) {
      // Malformed/non-JSON diagnostic output must never crash Node-RED.
      return null;
    }

    const type = TYPE_MAP[raw.type] || raw.type || "progress";
    return { type, sessionID: raw.sessionID, data: raw };
  }

  parseResult(events, exitCode, signal, stderr, resolved) {
    const raw = events.map((e) => e.data);
    const errorEvent = raw.find((e) => e.type === "error");
    const sessionID = raw.length ? raw[raw.length - 1].sessionID : undefined;

    const payload = raw
      .filter((e) => e.type === "text" && e.part && typeof e.part.text === "string")
      .map((e) => e.part.text)
      .join("\n")
      .trim();

    // Sums cost/tokens across every step_finish event seen during this run
    // -- verified against a real `opencode run --format json` invocation,
    // whose step_finish `part` carries { tokens: {input,output,reasoning,
    // cache:{read,write},total}, cost }. `costUsd`/`tokens` stay undefined
    // (rather than 0) when no step_finish event was observed at all, so
    // agent.js can omit the fields entirely instead of reporting a false 0.
    const usage = summarizeUsage(raw);

    if (errorEvent) {
      const errDetail = errorEvent.error || {};
      const message =
        (errDetail.data && errDetail.data.message) ||
        errDetail.name ||
        "opencode reported an error";
      // The JSON error event only carries opencode's own top-level
      // message/name -- append name (if distinct), its diagnostic ref (if
      // any -- note this does NOT reliably show up in opencode's own log
      // file, verified empirically, so it's a weak clue at best), and any
      // stderr output opencode wrote alongside it, since all three would
      // otherwise be silently dropped here (unlike the exitCode!==0
      // branch below, which already surfaces stderr).
      const extras = [];
      if (errDetail.name && errDetail.name !== message) extras.push(errDetail.name);
      if (errDetail.data && errDetail.data.ref) extras.push(`ref=${errDetail.data.ref}`);
      // "UnknownError" is opencode's catch-all for a request the provider/
      // server rejected before generating any content -- in practice the
      // single most common trigger we've seen is a `--model` value that
      // doesn't exist (wrong provider, typo, or a model that isn't
      // actually available to this account). It's not the only possible
      // cause, so this is phrased as a hint, not a diagnosis.
      if (errDetail.name === "UnknownError" && resolved && resolved.model) {
        extras.push(
          `possible cause: model "${resolved.model}" may not exist or isn't available -- run "opencode models" to check`,
        );
      }
      if (stderr && String(stderr).trim()) extras.push(String(stderr).trim());
      const errorMessage = extras.length ? `${message} (${extras.join("; ")})` : message;
      return Object.assign(
        {
          payload,
          sessionID,
          status: "failed",
          errorMessage,
          errorDetail: errDetail,
        },
        usage,
      );
    }
    if (signal) {
      return Object.assign(
        {
          payload,
          sessionID,
          status: "failed",
          errorMessage: `process killed by signal ${signal}`,
        },
        usage,
      );
    }
    if (exitCode !== 0) {
      return Object.assign(
        {
          payload,
          sessionID,
          status: "failed",
          errorMessage: `exited with code ${exitCode}${stderr ? ": " + String(stderr).trim() : ""}`,
        },
        usage,
      );
    }
    if (!payload) {
      return Object.assign(
        {
          payload,
          sessionID,
          status: "failed",
          errorMessage:
            "opencode produced no assistant output (silent rejection or empty response)",
        },
        usage,
      );
    }
    return Object.assign({ payload, sessionID, status: "completed" }, usage);
  }
}

// Sums cost (USD) and token counts across every step_finish event in a run.
// Returns {} (no keys at all) when no step_finish event carried usable
// data, so Object.assign(...) callers above never introduce costUsd/tokens
// keys with `undefined` values -- agent.js relies on the key's mere
// presence (not just its value) to decide whether to surface it.
function summarizeUsage(raw) {
  let costUsd;
  let tokens;
  for (const e of raw) {
    if (e.type !== "step_finish" || !e.part || typeof e.part !== "object") continue;
    const part = e.part;
    if (typeof part.cost === "number") {
      costUsd = (costUsd || 0) + part.cost;
    }
    if (part.tokens && typeof part.tokens === "object") {
      tokens = tokens || {
        total: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      };
      tokens.total += Number(part.tokens.total) || 0;
      tokens.input += Number(part.tokens.input) || 0;
      tokens.output += Number(part.tokens.output) || 0;
      tokens.reasoning += Number(part.tokens.reasoning) || 0;
      if (part.tokens.cache) {
        tokens.cache.read += Number(part.tokens.cache.read) || 0;
        tokens.cache.write += Number(part.tokens.cache.write) || 0;
      }
    }
  }
  const usage = {};
  if (costUsd !== undefined) usage.costUsd = costUsd;
  if (tokens !== undefined) usage.tokens = tokens;
  return usage;
}

OpenCodeAdapter.CAPABILITIES = {
  sessionResume: true, // opencode.js -s/--session verified working: an
  // unresolvable/bogus sessionID hard-fails the CLI (exit 1, zero JSON
  // events, "Session not found" on stderr) rather than silently
  // falling back to a fresh session -- verified empirically with real
  // CLI invocations. So `resumeOutcome()` (lib/execution/resume-
  // outcome.js) reaching `false` for this adapter today always
  // co-occurs with a failed execution; there is no known path where
  // OpenCode reports status:"completed" after silently discarding a
  // requested resume.
  structuredOutput: "best-effort", // no --schema/--json-schema CLI flag
  toolRestrictions: true, // via materialized temp agent config + --agent
  effortControl: true, // --variant, verified working
  systemPromptControl: false, // no CLI flag found
  costReporting: true, // step_finish tokens/cost already in --format json stream
};

const { registerAgent } = require("./registry");
registerAgent({ id: "opencode", factory: () => new OpenCodeAdapter() });
registerAgent({ id: "opencode-v1", factory: () => new OpenCodeAdapter({ fixedVersion: 1 }) });
registerAgent({ id: "opencode-v2", factory: () => new OpenCodeAdapter({ fixedVersion: 2 }) });

module.exports = { OpenCodeAdapter };
