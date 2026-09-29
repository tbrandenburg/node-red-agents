"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { startSmokeInstance } = require("./lib/node-red-instance");

const fixtureDir = path.join(__dirname, "fixtures", "lifecycle-cli");

function flow({ disabled = false, invalid = false } = {}) {
  const nodes = [
    { id: "lifecycle-tab", type: "tab", label: "lifecycle" },
    {
      id: "first-inject",
      type: "inject",
      z: "lifecycle-tab",
      props: [{ p: "payload" }],
      payload: invalid ? "" : "first",
      payloadType: "str",
      wires: [["first-agent"]],
    },
    {
      id: "second-inject",
      type: "inject",
      z: "lifecycle-tab",
      props: [{ p: "payload" }, { p: "agentObservation", v: '{"run":"second"}', vt: "json" }],
      payload: "second",
      payloadType: "str",
      wires: [["second-agent"]],
    },
    {
      id: "third-inject",
      type: "inject",
      z: "lifecycle-tab",
      props: [{ p: "payload" }, { p: "agentObservation", v: '{"run":"third"}', vt: "json" }],
      payload: "third",
      payloadType: "str",
      wires: [["first-agent"]],
    },
    {
      id: "first-agent",
      type: "agent",
      z: "lifecycle-tab",
      name: "first",
      agent: "opencode-v1",
      runtime: "direct",
      prompt: "payload",
      promptType: "msg",
      concurrency: 2,
      retryMaxAttempts: 1,
      d: disabled,
      wires: [["results"], ["events"]],
    },
    {
      id: "second-agent",
      type: "agent",
      z: "lifecycle-tab",
      name: "second",
      agent: "opencode-v1",
      runtime: "direct",
      prompt: "payload",
      promptType: "msg",
      retryMaxAttempts: 1,
      wires: [["results"], ["events"]],
    },
    {
      id: "results",
      type: "debug",
      z: "lifecycle-tab",
      active: true,
      tosidebar: true,
      complete: "true",
      targetType: "full",
      wires: [],
    },
    {
      id: "events",
      type: "debug",
      z: "lifecycle-tab",
      active: true,
      tosidebar: true,
      complete: "true",
      targetType: "full",
      wires: [],
    },
    {
      id: "errors",
      type: "debug",
      z: "lifecycle-tab",
      active: true,
      tosidebar: true,
      complete: "true",
      targetType: "full",
      wires: [],
    },
    {
      id: "catch",
      type: "catch",
      z: "lifecycle-tab",
      scope: ["first-agent", "second-agent"],
      wires: [["errors"]],
    },
  ];
  return nodes;
}

function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function until(check, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("timed out waiting for lifecycle evidence");
}

async function inject(instance, id) {
  const response = await fetch(`${instance.baseUrl}/inject/${id}`, { method: "POST" });
  assert.equal(response.status, 200);
}

async function debugStream(baseUrl) {
  const messages = [];
  const ws = new WebSocket(baseUrl.replace(/^http/, "ws") + "/comms");
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.send(JSON.stringify({ subscribe: "debug" }));
  ws.addEventListener("message", (event) => {
    for (const entry of JSON.parse(event.data)) {
      if (entry.topic === "debug") messages.push(entry.data);
    }
  });
  return { messages, close: () => ws.close() };
}

const observerSettings = `nodeRedAgentsLifecycleObserver: async (record) => {
  const fs = require('node:fs');
  const mode = fs.existsSync(process.env.LIFECYCLE_MODE) ? fs.readFileSync(process.env.LIFECYCLE_MODE, 'utf8').trim() : '';
  fs.appendFileSync(process.env.LIFECYCLE_EVENTS, JSON.stringify(record) + '\\n');
  if (record.type === 'node.deployed' && mode === 'deploy-outage') throw new Error('inventory offline');
  if (record.type === 'execution.started' && mode === 'reject-start') throw new Error('start offline');
  if (record.type === 'execution.terminal' && mode === 'reject-terminal') throw new Error('terminal offline');
  if (record.type === 'execution.started') await new Promise(resolve => setTimeout(resolve, 40));
}`;

test(
  "real Node-RED lifecycle: inventory, concurrent starts, failures, redeploy and disable",
  { timeout: 90000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-e2e-"));
    const events = path.join(dir, "events.jsonl");
    const mode = path.join(dir, "mode");
    fs.writeFileSync(mode, "deploy-outage");
    let instance;
    let stream;
    try {
      instance = await startSmokeInstance({
        settingsExtra: observerSettings,
        env: {
          LIFECYCLE_EVENTS: events,
          LIFECYCLE_MODE: mode,
          LIFECYCLE_CLI_DELAY_MS: "120",
          PATH: `${fixtureDir}${path.delimiter}${process.env.PATH}`,
        },
      });
      stream = await debugStream(instance.baseUrl);
      await instance.deployFlow(flow());
      await until(
        () => readEvents(events).filter((event) => event.type === "node.deployed").length >= 2,
      );
      assert.equal(readEvents(events).filter((entry) => entry.type === "cli").length, 0);
      fs.writeFileSync(mode, "");
      await Promise.all([
        inject(instance, "first-inject"),
        inject(instance, "second-inject"),
        inject(instance, "third-inject"),
      ]);
      await until(
        () => readEvents(events).filter((event) => event.type === "execution.terminal").length >= 3,
      );
      await until(() => stream.messages.filter((entry) => entry.id === "results").length >= 3);
      const initial = readEvents(events);
      const starts = initial.filter((event) => event.type === "execution.started");
      assert.equal(starts.length, 3);
      assert.equal(new Set(starts.map((record) => record.executionId)).size, 3);
      assert.equal(new Set(starts.map((record) => record.deploymentId)).size, 2);
      assert.deepEqual(starts.find((record) => record.input.prompt === "third").agentObservation, {
        run: "third",
      });
      for (const start of starts) {
        const startIndex = initial.indexOf(start);
        const cliIndex = initial.findIndex(
          (record, index) =>
            index > startIndex && record.type === "cli" && record.prompt === start.input.prompt,
        );
        assert.ok(cliIndex > startIndex, "CLI must run after the acknowledged start");
        assert.ok(
          initial.find(
            (record) =>
              record.type === "execution.terminal" && record.executionId === start.executionId,
          ),
        );
      }
      assert.equal(stream.messages.filter((entry) => entry.id === "results").length, 3);
      assert.ok(stream.messages.some((entry) => entry.id === "events"));
      await instance.deployFlow(flow({ invalid: true }));
      await until(
        () =>
          new Set(
            readEvents(events)
              .filter((entry) => entry.type === "node.deployed" && entry.nodeId === "first-agent")
              .map((entry) => entry.deploymentId),
          ).size >= 2,
      );
      const deployed = readEvents(events).filter(
        (entry) => entry.type === "node.deployed" && entry.nodeId === "first-agent",
      );
      const closed = readEvents(events).filter(
        (entry) => entry.type === "node.closed" && entry.nodeId === "first-agent",
      );
      assert.notEqual(deployed[0].deploymentId, deployed.at(-1).deploymentId);
      assert.equal(closed[0].deploymentId, deployed[0].deploymentId);
      const inventory = new Map();
      for (const entry of readEvents(events).filter(
        (record) => record.nodeId === "first-agent" && record.type.startsWith("node."),
      )) {
        if (entry.type === "node.deployed") inventory.set(entry.nodeId, entry.deploymentId);
        if (entry.type === "node.closed" && inventory.get(entry.nodeId) === entry.deploymentId) {
          inventory.delete(entry.nodeId);
        }
      }
      assert.equal(inventory.get("first-agent"), deployed.at(-1).deploymentId);
      await inject(instance, "first-inject");
      await until(
        () => readEvents(events).filter((entry) => entry.type === "execution.terminal").length >= 4,
      );
      assert.equal(
        readEvents(events)
          .filter((entry) => entry.type === "execution.terminal")
          .at(-1).status,
        "failed",
      );
      fs.writeFileSync(mode, "reject-start");
      await inject(instance, "third-inject");
      await until(
        () =>
          stream.messages.filter((entry) => entry.id === "first-agent" && entry.level === 20)
            .length >= 2,
      );
      const rejected = readEvents(events);
      assert.equal(rejected.filter((entry) => entry.type === "cli").length, 3);
      fs.writeFileSync(mode, "reject-terminal");
      await inject(instance, "third-inject");
      await until(
        () =>
          stream.messages.filter((entry) => entry.id === "first-agent" && entry.level === 20)
            .length >= 3,
      );
      assert.equal(readEvents(events).filter((entry) => entry.type === "cli").length, 4);
      assert.equal(stream.messages.filter((entry) => entry.id === "results").length, 3);
      fs.writeFileSync(mode, "");
      await instance.deployFlow(flow({ disabled: true }));
      await until(
        () =>
          readEvents(events).filter(
            (entry) => entry.type === "node.closed" && entry.nodeId === "first-agent",
          ).length >= 2,
      );
      const latest = readEvents(events);
      assert.equal(
        new Set(
          latest
            .filter((entry) => entry.type === "node.deployed" && entry.nodeId === "first-agent")
            .map((entry) => entry.deploymentId),
        ).size,
        2,
      );
      assert.equal(
        latest
          .filter((entry) => entry.type === "node.closed" && entry.nodeId === "first-agent")
          .at(-1).deploymentId,
        deployed.at(-1).deploymentId,
      );
      console.log(
        "lifecycle real Node-RED: 2 nodes, 3 parallel starts, redeploy/disable and failures verified",
      );
    } finally {
      if (stream) stream.close();
      if (instance) await instance.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "controlled CLI exceeds 360 seconds without a model deadline",
  { skip: process.env.LIFECYCLE_LONG !== "1", timeout: 440000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-long-"));
    const events = path.join(dir, "events.jsonl");
    const mode = path.join(dir, "mode");
    let instance;
    let stream;
    try {
      instance = await startSmokeInstance({
        settingsExtra: observerSettings,
        env: {
          LIFECYCLE_EVENTS: events,
          LIFECYCLE_MODE: mode,
          LIFECYCLE_CLI_DELAY_MS: "365000",
          PATH: `${fixtureDir}${path.delimiter}${process.env.PATH}`,
        },
      });
      stream = await debugStream(instance.baseUrl);
      await instance.deployFlow(flow());
      await until(() => readEvents(events).some((entry) => entry.type === "node.deployed"));
      await inject(instance, "first-inject");
      const start = await until(() =>
        readEvents(events).find((entry) => entry.type === "execution.started"),
      );
      const terminal = await until(
        () =>
          readEvents(events).find(
            (entry) =>
              entry.type === "execution.terminal" && entry.executionId === start.executionId,
          ),
        420000,
      );
      assert.equal(terminal.status, "completed");
      assert.ok(new Date(terminal.timestamp) - new Date(start.timestamp) > 360000);
      await until(() => stream.messages.some((entry) => entry.id === "results"));
      console.log("lifecycle real Node-RED: controlled CLI completed after >360 seconds");
    } finally {
      if (stream) stream.close();
      if (instance) await instance.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "real provider acknowledges start before the OpenCode response",
  { skip: process.env.LIFECYCLE_PROVIDER !== "1", timeout: 150000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-provider-"));
    const events = path.join(dir, "events.jsonl");
    let instance;
    let stream;
    try {
      instance = await startSmokeInstance({
        settingsExtra: observerSettings,
        env: { LIFECYCLE_EVENTS: events, LIFECYCLE_MODE: path.join(dir, "mode") },
      });
      stream = await debugStream(instance.baseUrl);
      const providerFlow = flow().map((node) =>
        node.type === "agent"
          ? {
              ...node,
              model: "opencode/big-pickle",
              modelType: "str",
              timeout: 120,
              timeoutType: "num",
            }
          : node,
      );
      await instance.deployFlow(providerFlow);
      await until(
        () => readEvents(events).filter((entry) => entry.type === "node.deployed").length >= 2,
      );
      await inject(instance, "first-inject");
      const start = await until(() =>
        readEvents(events).find((entry) => entry.type === "execution.started"),
      );
      assert.equal(
        readEvents(events).filter((entry) => entry.type === "execution.terminal").length,
        0,
      );
      await until(() => stream.messages.some((entry) => entry.id === "results"), 140000);
      const terminal = await until(() =>
        readEvents(events).find(
          (entry) => entry.type === "execution.terminal" && entry.executionId === start.executionId,
        ),
      );
      assert.equal(terminal.status, "completed");
      const output = stream.messages.find((entry) => entry.id === "results");
      assert.equal(typeof JSON.parse(output.msg).payload, "string");
      assert.ok(JSON.parse(output.msg).payload.length > 0);
      console.log("lifecycle real provider: acknowledged start preceded OpenCode response");
    } finally {
      if (stream) stream.close();
      if (instance) await instance.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "real Node-RED reports missing executable after acknowledged start",
  { timeout: 30000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-missing-"));
    const events = path.join(dir, "events.jsonl");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
    let instance;
    let stream;
    try {
      instance = await startSmokeInstance({
        settingsExtra: observerSettings,
        env: { LIFECYCLE_EVENTS: events, LIFECYCLE_MODE: path.join(dir, "mode"), PATH: bin },
      });
      stream = await debugStream(instance.baseUrl);
      await instance.deployFlow(flow());
      await until(() => readEvents(events).some((entry) => entry.type === "node.deployed"));
      await inject(instance, "first-inject");
      const start = await until(() =>
        readEvents(events).find((entry) => entry.type === "execution.started"),
      );
      const terminal = await until(() =>
        readEvents(events).find(
          (entry) => entry.type === "execution.terminal" && entry.executionId === start.executionId,
        ),
      );
      assert.equal(terminal.status, "failed");
      assert.match(terminal.output.errorMessage, /ENOENT|opencode/);
      await until(() =>
        stream.messages.some((entry) => entry.id === "first-agent" && entry.level === 20),
      );
      assert.equal(
        readEvents(events).filter((entry) => entry.type === "execution.terminal").length,
        1,
      );
    } finally {
      if (stream) stream.close();
      if (instance) await instance.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
