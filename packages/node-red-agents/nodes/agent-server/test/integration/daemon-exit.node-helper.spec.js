"use strict";

const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const helper = require("node-red-node-test-helper");
const server = require("../../agent-server");
const provider = require("../../../model-provider/model-provider");
const runtimeRequire = createRequire(require.resolve("node-red/package.json"));
const catchNode = runtimeRequire("@node-red/nodes/core/common/25-catch.js");
const fixture = path.join(__dirname, "../../fixtures/fake-opencode.js");
const key = "synthetic-inflight-daemon-key";

before(() => helper.startServer());
after(() => helper.stopServer());
afterEach(() => helper.unload());

function waitFor(emitter, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${event}`));
    }, 6000);
    function cleanup() {
      clearTimeout(timer);
      emitter.off(event, listener);
    }
    function listener(...args) {
      if (!predicate(...args)) return;
      cleanup();
      resolve(args);
    }
    emitter.on(event, listener);
  });
}

async function load(version) {
  await helper.load(
    [server, provider, catchNode],
    [
      { id: "tab", type: "tab", label: "daemon exit" },
      { id: "p", type: "model-provider", provider: "openrouter", defaultModel: "test/model" },
      {
        id: "s",
        type: "agent-server",
        z: "tab",
        x: 100,
        y: 100,
        apiVersionMode: version,
        opencodeBinary: fixture,
        authMode: "provider",
        modelProvider: "p",
        startupTimeoutMs: 3000,
        requestTimeoutMs: 3000,
        wires: [["out"], ["events"]],
      },
      { id: "out", type: "helper", z: "tab", x: 200, y: 100 },
      { id: "events", type: "helper", z: "tab", x: 200, y: 200 },
      { id: "catcher", type: "catch", z: "tab", x: 100, y: 300, scope: ["s"], wires: [["caught"]] },
      { id: "caught", type: "helper", z: "tab", x: 200, y: 300 },
    ],
    { p: { apiKey: key } },
  );
}

for (const [version, stage] of [
  ["v1", "message"],
  ["v2", "prompt"],
  ["v2", "poll"],
]) {
  test(
    `${version} SIGKILL during admitted ${stage} delivers exactly one Catch and failed event`,
    { timeout: 15000 },
    async () => {
      const unhandled = [];
      const onUnhandled = (error) => unhandled.push(error);
      process.on("unhandledRejection", onUnhandled);
      try {
        await load(version);
        const node = helper.getNode("s");
        const out = helper.getNode("out");
        const eventNode = helper.getNode("events");
        const caughtNode = helper.getNode("caught");
        const firstOutput = waitFor(out, "input");
        const firstCompleted = waitFor(
          eventNode,
          "input",
          (msg) => msg.payload.type === "completed",
        );
        node.receive({ payload: "hello" });
        const [[first]] = await Promise.all([firstOutput, firstCompleted]);
        const record = node.registry.get(first.sessionID);
        const child = record.child;
        const pid = child.pid;
        assert.ok(Number.isInteger(pid) && pid > 0);

        const outputs = [];
        const events = [];
        const errors = [];
        const caught = [];
        out.on("input", (msg) => outputs.push(msg));
        eventNode.on("input", (msg) => events.push(msg));
        caughtNode.on("input", (msg) => caught.push(msg));
        node.on("call:error", (call) => errors.push(call.args[0]));

        // Subscribe before sending; no sleep or synthetic registry/runtime injection.
        let stdout = "";
        const admitted = waitFor(child.stdout, "data", (chunk) => {
          stdout += chunk.toString();
          return stdout.includes(`fake-opencode: blocked ${stage}\n`);
        });
        const failed = waitFor(eventNode, "input", (msg) => msg.payload.type === "failed");
        const catchDelivered = waitFor(caughtNode, "input");
        const original = {
          _msgid: `inflight-${version}-${stage}`,
          sessionID: first.sessionID,
          payload: `block-${stage}`,
          topic: key,
          metadata: { token: "application-token", nested: ["preserved"] },
        };
        node.receive(original);
        await admitted;
        assert.equal(node.registry.get(first.sessionID).busy, true);
        assert.equal(child.exitCode, null);
        assert.equal(child.signalCode, null);
        const closed = waitFor(child, "close");
        process.kill(pid, "SIGKILL");
        const [[code, signal]] = await Promise.all([closed, failed, catchDelivered]);
        assert.equal(code, null);
        assert.equal(signal, "SIGKILL");
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(outputs.length, 0);
        assert.equal(errors.length, 1);
        assert.equal(caught.length, 1);
        assert.match(caught[0].error.message, /agent-server: message to session .* failed:/);
        assert.ok(!caught[0].error.message.includes(key));
        for (const field of Object.keys(original)) {
          assert.deepEqual(caught[0][field], original[field]);
        }
        assert.deepEqual(
          events.map((msg) => msg.payload.type),
          ["running", "failed"],
        );
        assert.equal(events.at(-1).topic, "[REDACTED]");
        assert.ok(!JSON.stringify(events).includes(key));
        assert.equal(node.registry.size(), 0);
        assert.deepEqual(node.registry.summary(), { total: 0, busy: 0, idle: 0, sessions: [] });

        // The retired key no longer participates in aggregate sanitization.
        const status = waitFor(out, "input");
        node.receive({ operation: "status", topic: key });
        const [reply] = await status;
        assert.equal(reply.topic, key);
        assert.equal(reply.payload.total, 0);
        await helper.unload();
        assert.deepEqual(
          events.map((msg) => msg.payload.type),
          ["running", "failed"],
        );
        assert.equal(errors.length, 1);
        assert.equal(caught.length, 1);
        assert.equal(unhandled.length, 0);
      } finally {
        await helper.unload();
        process.off("unhandledRejection", onUnhandled);
      }
    },
  );
}
