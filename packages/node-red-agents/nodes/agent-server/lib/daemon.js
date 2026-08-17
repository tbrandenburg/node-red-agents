"use strict";

const { spawn } = require("child_process");
const { request } = require("./http");

const GRACE_PERIOD_MS = 2000;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 200;
const MAX_BUFFERED_OUTPUT = 4000;

// Same argv-prefix technique as nodes/agent/lib/runtimes/srt.js:
// `srt [-s <settingsPath>] <command> [args...]`, no shell involved -- just
// wrapping `opencode serve` instead of `opencode run`. Kept as a pure
// function so the exact argv this node would spawn is unit-testable without
// touching child_process at all.
//
// IMPORTANT (verified empirically 2026-08-13): srt only sandboxes *outbound*
// network egress (network.allowedDomains/deniedDomains -- see `srt --help`,
// there is no inbound/listen-port concept at all). It isolates the
// sandboxed child into its own network namespace, so a process that itself
// needs to *accept* inbound connections -- like `opencode serve`'s HTTP
// server -- prints "listening on http://host:port" and genuinely never
// becomes reachable from outside the sandbox (confirmed with a trivial
// plain Node http server too, not opencode-specific). This is fine for the
// `agent` node (srt wraps `opencode run`, which is outbound-only), but SRT
// runtime here will always fail readiness (waitForHealthy times out) --
// there is currently no way to make a srt-sandboxed daemon reachable.
// Kept as an option (in case a future srt version adds inbound support)
// rather than removed, but treat it as non-functional today.
//
// config: { binary ('opencode'), hostname, port, srt: { enabled, binary, settingsPath } }
function buildCommand(config) {
  const serveArgs = ["serve", "--port", String(config.port), "--hostname", config.hostname];

  if (config.srt && config.srt.enabled) {
    const flags = [];
    if (config.srt.settingsPath) flags.push("-s", config.srt.settingsPath);
    return {
      cmd: config.srt.binary || "srt",
      args: [...flags, config.binary || "opencode", ...serveArgs],
    };
  }

  return { cmd: config.binary || "opencode", args: serveArgs };
}

// Bounded ring-buffer append: keeps only the last MAX_BUFFERED_OUTPUT chars,
// so a long-lived daemon's stdout/stderr can't leak memory over a session
// that stays open for hours.
function appendBounded(buffer, chunk) {
  const next = buffer + chunk;
  return next.length > MAX_BUFFERED_OUTPUT ? next.slice(next.length - MAX_BUFFERED_OUTPUT) : next;
}

// Spawns the daemon process (detached into its own process group, same
// reasoning as nodes/agent/lib/runtimes/process-exec.js: a single
// `-pid` kill later reaches the whole tree, e.g. srt's sandbox wrapper +
// the opencode process it spawns). stdin is closed immediately -- opencode
// (like most CLIs) would otherwise wait on it forever (see AGENTS.md).
//
// Does not wait for readiness -- call waitForHealthy() with the returned
// baseUrl afterwards.
function spawnDaemon(config) {
  const { cmd, args } = buildCommand(config);
  const state = { stdout: "", stderr: "" };

  const child = spawn(cmd, args, {
    cwd: config.cwd || undefined,
    env: config.env || process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    state.stdout = appendBounded(state.stdout, chunk.toString());
  });
  child.stderr.on("data", (chunk) => {
    state.stderr = appendBounded(state.stderr, chunk.toString());
  });

  return { child, cmd, args, diagnostics: state };
}

// Polls GET /global/health until it responds or timeoutMs elapses. Resolves
// with the parsed health body; rejects with a clear error (including
// whatever stderr the daemon produced, if any) on timeout.
async function waitForHealthy(
  baseUrl,
  { timeoutMs, intervalMs, username, password, diagnostics } = {},
) {
  const deadline = Date.now() + (timeoutMs || 15000);
  const interval = intervalMs || DEFAULT_HEALTH_POLL_INTERVAL_MS;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await request(`${baseUrl}/global/health`, {
        timeoutMs: interval * 4,
        username,
        password,
      });
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  const stderrTail =
    diagnostics && diagnostics.stderr ? ` -- stderr: ${diagnostics.stderr.trim()}` : "";
  throw new Error(
    `daemon at ${baseUrl} did not become healthy within ${timeoutMs}ms` +
      (lastError ? ` (last error: ${lastError.message})` : "") +
      stderrTail,
  );
}

// `-pid` reaches the whole detached process group (see spawnDaemon).
function killProcessGroup(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    try {
      child.kill(signal);
    } catch (_err) {
      // Already exited between the check above and here.
    }
  }
}

// SIGTERM, escalating to SIGKILL after GRACE_PERIOD_MS if it hasn't exited.
// Resolves once the process has actually exited, or after a safety cap so
// node close() can never hang forever on a daemon that refuses to die.
function killDaemon(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(safetyTimer);
      resolve();
    };

    child.once("exit", finish);
    killProcessGroup(child, "SIGTERM");

    const killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), GRACE_PERIOD_MS);
    const safetyTimer = setTimeout(finish, GRACE_PERIOD_MS + 2000);
  });
}

module.exports = {
  buildCommand,
  spawnDaemon,
  waitForHealthy,
  killDaemon,
  killProcessGroup,
  GRACE_PERIOD_MS,
};
