"use strict";

// Boots a real, throwaway Node-RED instance for the smoke/E2E suite --
// never data/ or demo/ (both hold real, checked-in flow content; this is
// disposable, deleted after every test run). See
// docs/260817_Refactoring.md step 15.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const NODE_RED_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "node-red");

// Polls GET /flows until it responds (or times out) instead of a fixed
// sleep -- Node-RED's own startup time varies with what's on the palette.
async function waitForReady(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + "/flows");
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `node-red did not become ready within ${timeoutMs}ms: ${lastError && lastError.message}`,
  );
}

// Starts a real `node-red` child process against a fresh temp userDir that
// has `@tbrandenburg/node-red-agents` available (via a symlinked
// node_modules pointing at the repo's own package -- see
// packages/node-red-agents). Returns { baseUrl, deployFlow(flow), stop() }.
async function startSmokeInstance({ port, readyTimeoutMs = 20000 } = {}) {
  const actualPort = port || 1900 + Math.floor(Math.random() * 500);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "nra-e2e-"));
  const baseUrl = `http://127.0.0.1:${actualPort}`;

  fs.mkdirSync(path.join(userDir, "node_modules"));
  // Only symlink the single package this suite actually needs, not the
  // whole root node_modules -- symlinking the entire directory caused
  // Node-RED's own startup (which creates subdirectories under
  // <userDir>/node_modules) to fail with ELOOP. The package is scoped
  // (@tbrandenburg/node-red-agents), so it needs its own scope directory.
  fs.mkdirSync(path.join(userDir, "node_modules", "@tbrandenburg"));
  fs.symlinkSync(
    path.join(REPO_ROOT, "packages", "node-red-agents"),
    path.join(userDir, "node_modules", "@tbrandenburg", "node-red-agents"),
    "dir",
  );
  fs.writeFileSync(
    path.join(userDir, "package.json"),
    JSON.stringify(
      {
        name: "nra-e2e-smoke",
        private: true,
        dependencies: { "@tbrandenburg/node-red-agents": "file:../packages/node-red-agents" },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(userDir, "settings.js"),
    `module.exports = { flowFile: 'flows.json', uiPort: ${actualPort}, logging: { console: { level: 'warn' } } };\n`,
  );
  fs.writeFileSync(path.join(userDir, "flows.json"), "[]");

  const child = spawn(NODE_RED_BIN, ["--userDir", userDir, "--port", String(actualPort)], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO_ROOT,
  });

  let stderrTail = "";
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  try {
    await waitForReady(baseUrl, readyTimeoutMs);
  } catch (err) {
    child.kill("SIGKILL");
    fs.rmSync(userDir, { recursive: true, force: true });
    throw new Error(`${err.message}\n--- node-red stderr tail ---\n${stderrTail}`);
  }

  async function deployFlow(flow) {
    const res = await fetch(baseUrl + "/flows", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Node-RED-Deployment-Type": "full" },
      body: JSON.stringify(flow),
    });
    if (res.status !== 204) {
      throw new Error(`POST /flows failed: ${res.status} ${await res.text()}`);
    }
  }

  function stop() {
    child.kill("SIGTERM");
    fs.rmSync(userDir, { recursive: true, force: true });
  }

  return { baseUrl, deployFlow, stop };
}

module.exports = { startSmokeInstance };
