"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const ROOT = path.resolve(__dirname, "../../..");
const WebSocket = require("node:module").createRequire(
  path.join(ROOT, "node_modules/@node-red/editor-api/package.json"),
)("ws");

function leakFree(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const secrets = [
    process.env.OPENROUTER_API_KEY,
    process.env.AI_GATEWAY_API_KEY,
    "sk-or-v1-synthetic-invalid-live-e2e",
  ];
  assert.ok(
    !secrets
      .filter(Boolean)
      .some((secret) =>
        [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")].some(
          (encoded) => text.includes(encoded),
        ),
      ),
    "credential leaked in observable data",
  );
}

async function runtime() {
  const http = require("node:http");
  const RED = require(path.join(ROOT, "node_modules/node-red"));
  const server = http.createServer();
  const native = global.fetch;
  // Observe real requests without replacing transport, responses, or SDK behavior.
  global.fetch = async (...args) => {
    const url = new URL(typeof args[0] === "string" ? args[0] : args[0].url || args[0]);
    const observed = ["openrouter.ai", "ai-gateway.vercel.sh"].includes(url.hostname);
    if (observed) process.send({ network: { path: url.pathname, phase: "start" } });
    const response = await native(...args);
    if (observed) process.send({ network: { path: url.pathname, status: response.status } });
    return response;
  };
  RED.init(server, {
    userDir: process.argv[3],
    flowFile: "flows.json",
    credentialSecret: process.argv[4],
    nodesDir: path.join(ROOT, "packages/node-red-agents"),
    debugMaxLength: 100000,
    logging: { console: { level: "info" } },
    editorTheme: { projects: { enabled: false } },
  });
  server.on("request", RED.httpAdmin);
  RED.events.on("flows:started", () => process.send({ deployed: true }));
  const started = once(RED.events, "flows:started");
  await RED.start();
  await started;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.send({ port: server.address().port });
  process.on("SIGTERM", async () => {
    await RED.stop();
    server.close(() => process.disconnect());
  });
}

async function start({ userDir, secret, cli = false, ambientCLI = false } = {}) {
  execFileSync("ss", ["-H", "-ltn"], { timeout: 5000 });
  const directory = userDir || fs.mkdtempSync(path.join(os.tmpdir(), "nra-model-live-"));
  const encryption = secret || require("node:crypto").randomBytes(32).toString("hex");
  const env = { ...process.env };
  // A successful SDK/CLI call must use provisioned native credentials, not ambient auth.
  for (const name of Object.keys(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|^OPENCODE_|^AI_GATEWAY_/i.test(name)) delete env[name];
  }
  if (cli) {
    if (ambientCLI) env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    for (const [name, suffix] of Object.entries({
      HOME: "home",
      XDG_CONFIG_HOME: "config",
      XDG_DATA_HOME: "share",
      XDG_CACHE_HOME: "cache",
      XDG_STATE_HOME: "state",
    })) {
      env[name] = path.join(directory, suffix);
      fs.mkdirSync(env[name], { recursive: true });
    }
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      autoupdate: false,
      share: "disabled",
      permission: { "*": "deny" },
      server: { hostname: "127.0.0.1" },
      provider: { openrouter: { options: { timeout: 55000, maxRetries: 0 } } },
    });
  }
  const child = fork(__filename, ["--runtime", directory, encryption], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let logs = "";
  const network = [];
  let deployments = 0;
  child.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.on("message", (message) => {
    if (message.network) network.push(message.network);
    if (message.deployed) deployments++;
  });
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) {
      leakFree(logs);
      return;
    }
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    await exit;
    clearTimeout(timer);
    leakFree(logs);
  }
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("real Node-RED startup timed out")), 30000);
      child.on("message", (message) => {
        if (message.port) {
          clearTimeout(timer);
          resolve(message.port);
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("real Node-RED exited during startup"));
      });
      child.once("error", reject);
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    async function request(route, options = {}) {
      return fetch(baseUrl + route, { ...options, signal: AbortSignal.timeout(10000) });
    }
    async function deploy(flow, key) {
      const previous = deployments;
      const nodes = flow.map((node) =>
        node.id === "live-provider" && key !== undefined
          ? { ...node, credentials: { apiKey: key } }
          : node,
      );
      const response = await request("/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nodes),
      });
      assert.equal(response.status, 204, "native flow deployment failed");
      for (let attempt = 0; attempt < 100; attempt++) {
        if (deployments > previous) return;
        await delay(100);
      }
      throw new Error("Node-RED flow deployment did not finish within 10s");
    }
    async function run(properties) {
      const messages = { final: [], event: [], error: [] };
      const socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/comms");
      const resultCleanup = [];
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try {
            const errors = [...logs.matchAll(/(?:Error|error)[^\n]*/g)].map((match) => match[0]);
            leakFree(errors);
            reject(new Error(`live flow timed out (65s); errors=${JSON.stringify(errors)}`));
          } catch (error) {
            reject(error);
          }
        }, 65000);
        let quiet;
        socket.addEventListener("error", () => reject(new Error("Node-RED comms failed")));
        socket.addEventListener("message", ({ data }) => {
          try {
            leakFree(data);
            for (const event of JSON.parse(data)) {
              if (event.topic !== "debug" || !Object.hasOwn(messages, event.data.id)) continue;
              messages[event.data.id].push(JSON.parse(event.data.msg));
              if (event.data.id !== "event") {
                clearTimeout(quiet);
                quiet = setTimeout(() => {
                  clearTimeout(timer);
                  resolve(messages);
                }, 350);
              }
            }
          } catch (error) {
            reject(error);
          }
        });
        socket.addEventListener("open", async () => {
          try {
            socket.send(JSON.stringify({ subscribe: "debug" }));
            await delay(100);
            for (let attempt = 0; attempt < 30; attempt++) {
              const response = await request("/inject/live-inject", {
                method: "POST",
                ...(properties
                  ? {
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ __user_inject_props__: properties }),
                    }
                  : {}),
              });
              if (response.status === 200) return;
              assert.equal(response.status, 404, "unexpected inject response");
              await delay(100);
            }
            const missing = [
              ...logs.matchAll(/(?:missing|waiting for|flows|Error|error)[^\n]*/gi),
            ].map((match) => match[0]);
            leakFree(missing);
            reject(
              new Error(`Inject endpoint never registered; diagnostics=${JSON.stringify(missing)}`),
            );
          } catch (error) {
            reject(error);
          }
        });
        // Keep every exit path bounded, including failed inject/transport.
        resultCleanup.push(() => {
          clearTimeout(timer);
          clearTimeout(quiet);
        });
      });
      try {
        return await result;
      } finally {
        resultCleanup.forEach((cleanup) => cleanup());
        socket.close();
        leakFree(logs);
      }
    }
    return {
      userDir: directory,
      secret: encryption,
      network,
      request,
      deploy,
      run,
      stop,
      remove: () => fs.rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await stop();
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[2] === "--runtime")
  runtime().catch(() => {
    throw new Error("real Node-RED startup failed");
  });
module.exports = { start, leakFree };
