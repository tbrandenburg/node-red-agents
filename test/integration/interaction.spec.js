"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { startSmokeInstance } = require("./lib/node-red-instance");

function flow() {
  const z = "interaction-tab";
  const inject = (id, props, wires) => ({ id, z, type: "inject", props, wires: [wires] });
  const prop = (p, value) => ({ p, v: JSON.stringify(value), vt: "json" });
  const debug = (id) => ({
    id,
    z,
    type: "debug",
    active: true,
    tosidebar: true,
    complete: "true",
    targetType: "full",
    wires: [],
  });
  return [
    { id: z, type: "tab", label: "interaction acceptance" },
    inject("start", [prop("payload", { order: 123 }), prop("before", { trace: "kept" })], ["gate"]),
    inject("respond", [], ["response"]),
    inject("ready", [], ["ready-debug"]),
    {
      id: "gate",
      z,
      type: "interaction",
      name: "Review",
      prompt: '"Review order " & payload.order',
      promptType: "jsonata",
      decisions: [
        { id: "use-a", label: "Use A" },
        { id: "revise", label: "Changes" },
      ],
      wires: [["continued"], ["present"]],
    },
    {
      id: "present",
      z,
      type: "function",
      func: 'flow.set("pending", msg.interaction); msg.payload.order = 999; msg.before.trace = "mutated"; return msg;',
      wires: [["requested"]],
    },
    {
      id: "response",
      z,
      type: "function",
      func: 'msg.payload = "response-only"; msg.extra = true; msg.interaction = {id: flow.get("pending").id, decision: "revise", text: "Add a test"}; return msg;',
      wires: [["gate"]],
    },
    { id: "complete", z, type: "complete", scope: ["gate"], wires: [["completed"]] },
    { id: "catch", z, type: "catch", scope: ["gate"], wires: [["caught"]] },
    ...["continued", "requested", "completed", "caught", "ready-debug"].map(debug),
  ].map((node) => (node.type === "tab" ? node : { x: 200, y: 100, ...node }));
}

async function stream(baseUrl) {
  const events = [];
  const waiters = new Set();
  const ws = new WebSocket(baseUrl.replace(/^http/, "ws") + "/comms");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), 5000);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
      { once: true },
    );
  });
  ws.addEventListener("message", (event) => {
    events.push(...JSON.parse(event.data));
    for (const check of waiters) check();
  });
  ws.send(JSON.stringify({ subscribe: "debug" }));
  ws.send(JSON.stringify({ subscribe: "notification/#" }));
  function wait(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Debug timeout: ${JSON.stringify(events)}`));
      }, 5000);
      function check() {
        const found = events.find(predicate);
        if (!found) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(found);
      }
      waiters.add(check);
      check();
    });
  }
  return { events, wait, close: () => ws.close() };
}

test(
  "standalone real Node-RED: later same-input resolution, isolation, completion, errors and redeploy",
  { timeout: 40000 },
  async () => {
    let instance;
    let observer;
    try {
      instance = await startSmokeInstance();
      observer = await stream(instance.baseUrl);
      const nodes = flow();
      async function deploy() {
        observer.events.length = 0;
        await instance.deployFlow(nodes);
        await observer.wait((entry) => entry.topic === "notification/runtime-deploy");
        // Runtime-deploy notification signals flows have started, before injecting.
        await fire("ready");
        await debug("ready-debug");
        observer.events.length = 0;
      }
      async function fire(id, msg) {
        const res = await fetch(`${instance.baseUrl}/inject/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg ? { __user_inject_props__: Object.keys(msg), ...msg } : {}),
        });
        assert.equal(res.status, 200);
      }
      const debug = async (id) => {
        try {
          return await observer.wait((entry) => entry.topic === "debug" && entry.data.id === id);
        } catch (err) {
          throw new Error(`Waiting for ${id}: ${err.message}`, { cause: err });
        }
      };
      const count = (id) =>
        observer.events.filter((entry) => entry.topic === "debug" && entry.data.id === id).length;
      async function error(msg, pattern) {
        observer.events.length = 0;
        await fire("start", msg);
        const entry = await debug("caught");
        assert.match(JSON.parse(entry.data.msg).error.message, pattern);
        assert.equal(count("continued"), 0);
        assert.equal(count("requested"), 0);
      }
      await deploy();
      await fire("start");
      const request = JSON.parse((await debug("requested")).data.msg);
      await debug("completed");
      assert.equal(count("continued"), 0);
      assert.equal(count("requested"), 1);
      assert.equal(request.interaction.status, "pending");
      assert.equal(request.interaction.prompt, "Review order 123");
      assert.deepEqual(request.interaction.decisions, [
        { id: "use-a", label: "Use A" },
        { id: "revise", label: "Changes" },
      ]);
      const id = request.interaction.id;
      await error({ interaction: { id, decision: "invalid" } }, /Undeclared/);
      await error({ interaction: { id: "unknown", decision: "revise" } }, /Unknown/);
      await error({ interaction: { id, status: "pending" } }, /loopback/);
      await error({ interaction: { id } }, /decision/);
      await fire("respond");
      const result = JSON.parse((await debug("continued")).data.msg);
      await debug("completed");
      assert.deepEqual(result.payload, { order: 123 });
      assert.deepEqual(result.before, { trace: "kept" });
      assert.equal(result.extra, undefined);
      assert.deepEqual(result.interaction, { id, decision: "revise", text: "Add a test" });
      assert.equal(count("continued"), 1);
      await error({ interaction: { id, decision: "revise" } }, /Unknown/);
      await fire("start");
      const pending = JSON.parse((await debug("requested")).data.msg).interaction.id;
      await debug("completed");
      await deploy();
      await error({ interaction: { id: pending, decision: "use-a" } }, /Unknown/);
      console.log(
        "interaction real Node-RED: Request=1 Continue=0 while pending; Complete received before response; later Continue=1; original payload/context isolated; invalid/unknown/duplicate/loopback/malformed rejected; redeploy drops map",
      );
    } finally {
      if (observer) observer.close();
      if (instance) await instance.stop();
    }
  },
);
