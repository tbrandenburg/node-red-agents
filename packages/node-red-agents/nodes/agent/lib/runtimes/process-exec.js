"use strict";

// Shared spawn/timeout/kill logic used by both the Direct and SRT runtimes.
// Direct and SRT differ only in *which* command+args get spawned (see
// direct.js / srt.js) -- everything about process lifecycle, JSONL line
// buffering, and timeout handling lives here exactly once.
const { spawn } = require("child_process");
const { processTable, ownedDescendants, signalOwned } = require("./process-ownership");

const GRACE_PERIOD_MS = 2000;

// executionId -> { child, timeoutTimer, killTimer, timedOut }
const registry = new Map();

function killProcessGroup(child, signal) {
  if (!child || !child.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // `detached: true` (see runProcess) gives the child its own process
    // group with pgid === child.pid, so `-pid` reaches the whole tree
    // (e.g. srt's bwrap wrapper + the agent CLI it spawns), leaving no
    // orphans -- verified manually against a real `srt`-wrapped process.
    process.kill(-child.pid, signal);
  } catch (err) {
    try {
      child.kill(signal);
    } catch (_err) {
      // Process likely already exited between the check above and here.
    }
  }
}

function stop(state) {
  if (state.stopping) return;
  state.stopping = true;
  const policy = state.cancellation;
  if (policy) {
    state.cancelled = true;
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    try {
      // Once exit is known, a recycled leader PID cannot establish new ownership.
      if (state.child.exitCode === null && state.child.signalCode === null)
        state.owned = ownedDescendants(state.child.pid, processTable());
    } catch (error) {
      state.diagnostic += `Could not inspect owned descendants: ${error.message}\n`;
    }
  }
  killProcessGroup(state.child, policy?.signal || "SIGTERM");
  state.killTimer = setTimeout(() => forceStop(state), policy?.graceMs || GRACE_PERIOD_MS);
}

function forceStop(state) {
  killProcessGroup(state.child, "SIGKILL");
  if (!state.owned.length) return;
  try {
    const table = processTable();
    signalOwned(state.owned, state.child.pid, table);
  } catch (error) {
    state.diagnostic += `Could not inspect owned descendants: ${error.message}\n`;
  }
}

function runProcess(executionRequest, handlers = {}) {
  const { id, cmd, args, cwd, env, timeoutMs, cancellation } = executionRequest;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: cwd || undefined,
        env: env || process.env,
        detached: true,
        // Agent CLIs (opencode, srt-wrapped or not) wait on stdin if
        // it's left open as a pipe; close it so they behave like a
        // normal non-interactive invocation (see AGENTS.md).
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err);
      return;
    }

    const state = {
      child,
      timeoutTimer: null,
      killTimer: null,
      timedOut: false,
      cancellation,
      cancelled: false,
      stopping: false,
      owned: [],
      diagnostic: "",
    };
    registry.set(id, state);

    let lineBuffer = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      if (state.cancelled) return;
      lineBuffer += chunk.toString();
      let idx;
      while ((idx = lineBuffer.indexOf("\n")) >= 0) {
        if (state.cancelled) {
          lineBuffer = "";
          return;
        }
        const line = lineBuffer.slice(0, idx);
        lineBuffer = lineBuffer.slice(idx + 1);
        if (handlers.onLine) handlers.onLine(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    if (timeoutMs && timeoutMs > 0) {
      state.timeoutTimer = setTimeout(() => {
        state.timedOut = true;
        stop(state);
      }, timeoutMs);
    }

    child.on("error", (err) => {
      cleanupTimers(state);
      registry.delete(id);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (state.cancelled) forceStop(state);
      if (!state.cancelled && lineBuffer.length && handlers.onLine) handlers.onLine(lineBuffer);
      cleanupTimers(state);
      registry.delete(id);
      resolve({
        exitCode: code,
        signal,
        stderr: stderr + state.diagnostic,
        timedOut: state.timedOut,
        pid: child.pid,
        ...(cancellation ? { cancelled: state.cancelled } : {}),
      });
    });
  });
}

function cleanupTimers(state) {
  if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
  if (state.killTimer) clearTimeout(state.killTimer);
}

function terminate(id) {
  const state = registry.get(id);
  if (!state) return;
  stop(state);
}

module.exports = { runProcess, terminate, killProcessGroup, GRACE_PERIOD_MS };
