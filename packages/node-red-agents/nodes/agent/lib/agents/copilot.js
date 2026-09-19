"use strict";

const fs = require("fs");
const path = require("path");
const { AgentAdapter } = require("./base");
const { toCopilotMcp } = require("../mcp/normalize");

// Maps the real Copilot CLI `--output-format json` event stream (verified
// empirically against `copilot` v1.0.86) onto the Agent node's generic
// event vocabulary. Deliberately coarser than the CLI's own granularity:
// `assistant.message_delta` (streamed fragments) is skipped in favor of
// the single completed `assistant.message` event, same rationale as
// pi.js's *_delta skipping.
const TYPE_MAP = {
  "session.mcp_server_status_changed": "progress",
  "session.mcp_servers_loaded": "progress",
  "session.tools_updated": "progress",
  "user.message": "progress",
  "assistant.turn_start": "started",
  "model.call_start": "progress",
  "assistant.message_start": "progress",
  "assistant.message_delta": "progress",
  "tool.execution_start": "tool",
  "tool.execution_complete": "tool",
  "model.call_finished": "progress",
  "assistant.message": "agent",
  "assistant.turn_end": "progress",
  "session.usage_checkpoint": "progress",
  "assistant.idle": "progress",
  // Not directly observed in a successful transcript (issue #46/Task 1
  // did not surface a `session.error` event in the empirically verified
  // failure paths -- bad model/resume instead exit non-zero with zero or
  // partial JSON stdout, handled in parseResult()'s exitCode branch), but
  // kept as a defensive mapping in case the CLI ever does emit one.
  "session.error": "failed",
};

// Copilot has no `--skill`/`--command` CLI flag (verified against
// `copilot --help`) -- mirrors pi.js's directory-convention resolution
// for turning a bare invocationName into a real file path so it can be
// spelled out in the synthesized prompt instruction. Re-implemented
// locally (not imported from pi.js) per the plan's "duplication here is
// acceptable, keep changes minimal" guidance.
const RESOURCE_DIRS = {
  skill: ".github/skills",
  command: ".github/prompts",
};

function resolveResourcePath(name, kind, cwd) {
  const base = cwd || process.cwd();
  const candidates = [];

  if (path.isAbsolute(name)) {
    candidates.push(name);
  } else if (name.includes("/") || name.endsWith(".md")) {
    candidates.push(path.join(base, name));
  }

  const dir = RESOURCE_DIRS[kind];
  candidates.push(path.join(base, dir, name, "SKILL.md"));
  candidates.push(path.join(base, dir, `${name}.md`));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `could not find a ${kind} named "${name}" (looked for: ${candidates.join(", ")})`,
  );
}

class CopilotAdapter extends AgentAdapter {
  validate(resolved) {
    // Copilot model ids are bare (e.g. "claude-sonnet-5", "gpt-5.4"), not
    // "provider/model" like OpenCode's -- deliberately does NOT call
    // assertModelFormat() here (that check is OpenCode-specific).

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
      if (!resolved.invocationName || !String(resolved.invocationName).trim()) {
        throw new Error(`${resolved.invocation} invocation requires a non-empty name`);
      }
      // Throws its own clear error if nothing matches -- fail before
      // spawning anything, per the adapter contract.
      resolveResourcePath(resolved.invocationName, resolved.invocation, resolved.cwd);
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
    const args = ["--output-format", "json", "--allow-all-tools"];

    // --resume <id> is resume-ONLY: verified to hard-fail (exit 1, zero
    // JSON stdout) on an unresolvable id, unlike --session-id's dual
    // create-or-resume semantics (which silently succeeds/creates a new
    // session on an unknown id). Never use --session-id here -- that
    // would make resumeOutcome() always report a false positive.
    if (resolved.sessionID) args.push("--resume", String(resolved.sessionID));

    if (resolved.cwd) args.push("--add-dir", resolved.cwd);
    if (resolved.model) args.push("--model", resolved.model);

    // --effort/--reasoning-effort verified working against a real
    // `copilot` invocation (choices: none, minimal, low, medium, high,
    // xhigh, max) -- passed straight through, no clamping.
    if (CopilotAdapter.CAPABILITIES.effortControl && resolved.effort) {
      args.push("--effort", resolved.effort);
    }

    // allowedTools/deniedTools (issue #25 parity): --allow-tool/--deny-tool
    // verified present in `copilot --help`; the most direct mapping of
    // resolved.allowedTools/deniedTools onto the CLI's own flags.
    const hasAllow =
      CopilotAdapter.CAPABILITIES.toolRestrictions &&
      Array.isArray(resolved.allowedTools) &&
      resolved.allowedTools.length > 0;
    const hasDeny =
      CopilotAdapter.CAPABILITIES.toolRestrictions &&
      Array.isArray(resolved.deniedTools) &&
      resolved.deniedTools.length > 0;
    if (hasAllow) args.push(`--allow-tool=${resolved.allowedTools.join(",")}`);
    if (hasDeny) args.push(`--deny-tool=${resolved.deniedTools.join(",")}`);

    // --additional-mcp-config <json>: verified schema requires a
    // top-level {"mcpServers": {...}} wrapper (see toCopilotMcp()).
    // KNOWN LIMITATION (not fixed here, see normalize.js's comment): the
    // global ~/.copilot/mcp-config.json always loads regardless of this
    // flag.
    if (Array.isArray(resolved.mcpServers) && resolved.mcpServers.length > 0) {
      args.push("--additional-mcp-config", JSON.stringify(toCopilotMcp(resolved.mcpServers)));
    }

    // No --skill/--command CLI flag exists (verified) -- synthesize a
    // natural-language instruction instead, exactly like pi.js's pattern.
    let message;
    if (resolved.invocation === "prompt") {
      message = String(resolved.prompt);
    } else {
      const resourcePath = resolveResourcePath(
        resolved.invocationName,
        resolved.invocation,
        resolved.cwd,
      );
      const kind = resolved.invocation === "skill" ? "skill" : "prompt template";
      const argsText =
        resolved.args !== undefined && resolved.args !== null ? String(resolved.args) : "";
      message =
        `Use the "${resolved.invocationName}" ${kind} at ${resourcePath}. ${argsText}`.trim();
    }
    args.push("-p", message);

    // Auth is fully via env vars already inherited from process.env
    // (lib/execution/lifecycle.js merges these already) -- zero
    // adapter-side auth code needed.
    return { command: "copilot", args, env: {} };
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

    if (raw.type === "result") {
      return { type: "completed", sessionID: raw.sessionId, data: raw };
    }

    const type = TYPE_MAP[raw.type] || "progress";
    return { type, sessionID: raw.sessionId, data: raw };
  }

  parseResult(events, exitCode, signal, stderr, resolved) {
    const raw = events.map((e) => e.data);
    const errorEvent = raw.find((e) => e.type === "session.error");
    const resultEvent = [...raw].reverse().find((e) => e.type === "result");
    const finalMessage = [...raw].reverse().find((e) => e.type === "assistant.message");

    const sessionID = resultEvent
      ? resultEvent.sessionId
      : finalMessage
        ? finalMessage.sessionId
        : raw.length
          ? raw[raw.length - 1].sessionId
          : undefined;

    const payload =
      finalMessage && finalMessage.data && typeof finalMessage.data.content === "string"
        ? finalMessage.data.content.trim()
        : "";

    const usage = summarizeUsage(resultEvent);

    if (errorEvent) {
      const detail = errorEvent.data || {};
      const message = detail.message || "copilot reported a session error";
      const extras = [];
      if (stderr && String(stderr).trim()) extras.push(String(stderr).trim());
      const errorMessage = extras.length ? `${message} (${extras.join("; ")})` : message;
      return Object.assign(
        { payload, sessionID, status: "failed", errorMessage, errorDetail: detail },
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
      // Bad --model and bad --resume both verified to exit 1 with a clear
      // stderr message and zero (or partial) JSON stdout -- surface
      // stderr directly, same as opencode.js's exitCode!==0 branch.
      const stderrText = stderr ? String(stderr).trim() : "";
      let hint = "";
      if (resolved && resolved.model && /model/i.test(stderrText)) {
        hint = ` (possible cause: model "${resolved.model}" may not exist or isn't available)`;
      }
      return Object.assign(
        {
          payload,
          sessionID,
          status: "failed",
          errorMessage: `exited with code ${exitCode}${stderrText ? ": " + stderrText : ""}${hint}`,
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
          errorMessage: "copilot produced no assistant output (silent rejection or empty response)",
        },
        usage,
      );
    }
    return Object.assign({ payload, sessionID, status: "completed" }, usage);
  }
}

// Reads cost/token usage from the terminal {type:"result", usage:{...}}
// event -- a different shape than opencode's per-step summing, needs its
// own field mapping. Returns {} (no keys at all) when no result event
// carried usable data, so Object.assign(...) callers never introduce
// costUsd/tokens keys with `undefined` values.
function summarizeUsage(resultEvent) {
  const usage = {};
  if (!resultEvent || !resultEvent.usage || typeof resultEvent.usage !== "object") return usage;
  const u = resultEvent.usage;
  if (typeof u.premiumRequests === "number") {
    usage.tokens = {
      premiumRequests: u.premiumRequests,
      totalApiDurationMs: Number(u.totalApiDurationMs) || 0,
      sessionDurationMs: Number(u.sessionDurationMs) || 0,
    };
  }
  return usage;
}

CopilotAdapter.CAPABILITIES = {
  sessionResume: true, // --resume=<id> verified: hard-fails (exit 1, zero stdout) on unknown id
  structuredOutput: "best-effort", // no --schema/--json-schema flag found
  toolRestrictions: true, // --allow-tool/--deny-tool verified present in --help
  effortControl: true, // --effort/--reasoning-effort verified working
  systemPromptControl: false, // no CLI flag found
  costReporting: true, // terminal result.usage + session.usage_checkpoint events
};

const { registerAgent } = require("./registry");
registerAgent({ id: "copilot", factory: () => new CopilotAdapter() });

module.exports = { CopilotAdapter, resolveResourcePath };
