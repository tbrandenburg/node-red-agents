"use strict";

const assert = require("node:assert/strict");
const { test, before, after, afterEach } = require("node:test");
const helper = require("node-red-node-test-helper");
const register = require("../interaction");
const semantics = require("../lib/interaction");
const fs = require("node:fs");
const path = require("node:path");

before(() => helper.startServer());
after(() => helper.stopServer());
afterEach(async () => {
  await helper.unload();
  helper.settings({});
});

async function load(config = {}) {
  await helper.load(register, [
    { id: "tab", type: "tab" },
    {
      id: "gate",
      z: "tab",
      type: "interaction",
      prompt: "Continue?",
      wires: [["continued"], ["requested"]],
      ...config,
    },
    { id: "continued", type: "helper" },
    { id: "requested", type: "helper" },
  ]);
  return helper.getNode("gate");
}

function once(node, event = "input") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 2000);
    node.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args[0]);
    });
  });
}

function invoke(node, msg) {
  return new Promise((resolve) => node._inputCallback(msg, node.send.bind(node), resolve));
}

test("published registration and editor have one input, Continue/Request outputs and only the three fields", () => {
  const pkg = require("../../../package.json");
  assert.equal(pkg["node-red"].nodes.interaction, "nodes/interaction/interaction.js");
  const html = fs.readFileSync(path.join(__dirname, "..", "interaction.html"), "utf8");
  assert.match(html, /inputs: 1/);
  assert.match(html, /outputs: 2/);
  assert.match(html, /outputLabels: \["Continue", "Request"\]/);
  assert.deepEqual(
    [...html.matchAll(/<label[^>]*>([^<]+)<\/label>/g)].map((match) => match[1]),
    ["Name", "Prompt", "Decisions"],
  );
  assert.match(html, /human-on-the-loop \/ human-in-the-loop/);
});

test("request completes while pending; separate resolution restores isolated original exactly once", async () => {
  const node = await load({ name: "Review" });
  const outputs = [];
  helper.getNode("continued").on("input", (msg) => outputs.push(msg));
  const requested = once(helper.getNode("requested"));
  const input = { payload: { order: 123 }, context: { trace: "kept" } };
  assert.equal(await invoke(node, input), undefined);
  const request = await requested;
  assert.equal(outputs.length, 0);
  assert.match(request.interaction.id, /^[0-9a-f-]{36}$/);
  assert.equal(request.interaction.prompt, "Continue?");
  assert.deepEqual(request.interaction.decisions, semantics.decisions());
  request.payload.order = 999;
  request.context.trace = "changed";
  request.interaction.decisions[0].id = "corrupted";
  input.payload.order = 888;
  const id = request.interaction.id;
  assert.match(
    (await invoke(node, { interaction: { id, decision: "use-a" } })).message,
    /Undeclared/,
  );
  assert.match(
    (await invoke(node, { interaction: { id: "missing", decision: "approve" } })).message,
    /Unknown/,
  );
  assert.match(
    (await invoke(node, { interaction: { id, status: "pending" } })).message,
    /loopback/,
  );
  const continued = once(helper.getNode("continued"));
  assert.equal(
    await invoke(node, {
      payload: "response",
      extra: true,
      interaction: { id, decision: "approve", text: "Looks good" },
    }),
    undefined,
  );
  const result = await continued;
  assert.deepEqual(result.payload, { order: 123 });
  assert.deepEqual(result.context, { trace: "kept" });
  assert.equal(result.extra, undefined);
  assert.deepEqual(result.interaction, { id, decision: "approve", text: "Looks good" });
  assert.match(
    (await invoke(node, { interaction: { id, decision: "approve" } })).message,
    /Unknown/,
  );
  assert.equal(outputs.length, 1);
});

test("typed prompts use real Node-RED msg, context and asynchronous JSONata resolution", async () => {
  const node = await load({
    prompt: "question",
    promptType: "msg",
    decisions: [{ id: "use-a" }, { id: "revise", label: "Changes" }],
  });
  const plan = await node.interaction.plan({ question: "Which?" });
  assert.equal(plan.version, 1);
  assert.equal(plan.nodeId, "gate");
  assert.equal(plan.nodeName, "");
  assert.deepEqual(plan.decisions, [
    { id: "use-a", label: "use-a" },
    { id: "revise", label: "Changes" },
  ]);
  assert.equal(plan.prompt, "Which?");
  await helper.unload();
  const context = await load({ prompt: "question", promptType: "flow" });
  context.context().flow.set("question", "Context?");
  assert.equal((await context.interaction.plan({})).prompt, "Context?");
  await helper.unload();
  const jsonata = await load({ prompt: '"Order " & payload.order', promptType: "jsonata" });
  assert.equal((await jsonata.interaction.plan({ payload: { order: 123 } })).prompt, "Order 123");
});

test("validation errors fail input and malformed host resume never routes", async () => {
  for (const choices of [
    [],
    [{ id: "" }],
    [{ id: "x" }, { id: "x" }],
    [{ id: "unsafe value" }],
    [{ id: "ok", label: 3 }],
    null,
  ]) {
    assert.throws(() => semantics.decisions(choices));
  }
  const node = await load({ prompt: "question", promptType: "msg" });
  for (const msg of [
    {},
    { question: " " },
    { question: 3 },
    { interaction: {} },
    { interaction: null },
    { interaction: { id: "x" } },
  ]) {
    assert.ok(await invoke(node, msg));
  }
  const plan = await node.interaction.plan({ question: "Continue?" });
  for (const bad of [
    { ...plan, version: 2 },
    { ...plan, nodeId: "other" },
    { ...plan, decisions: undefined },
    { ...plan, prompt: "" },
    { ...plan, interactionId: "" },
  ]) {
    assert.throws(() => node.interaction.resume(bad, {}, { decision: "approve" }));
  }
  assert.throws(() => node.interaction.resume(plan, {}, { decision: "approve", text: 3 }), /text/);
  assert.throws(() => node.interaction.resume(plan, null, { decision: "approve" }), /Original/);
  await assert.rejects(
    node.interaction.plan({ interaction: { id: "x", decision: "approve" } }),
    /ordinary/,
  );
});

test("host checkpoint path bypasses map, returns done, and fresh-node resume uses ordinary routing", async () => {
  const records = [];
  helper.settings({
    nodeRedAgentsInteractionHost: {
      version: 1,
      async suspend(record) {
        records.push(record);
      },
    },
  });
  const node = await load();
  const sent = [];
  helper.getNode("requested").on("input", (msg) => sent.push(msg));
  helper.getNode("continued").on("input", (msg) => sent.push(msg));
  assert.equal(await invoke(node, { payload: { order: 123 }, before: 1 }), undefined);
  assert.equal(records.length, 1);
  assert.equal(sent.length, 0);
  const { plan, msg } = records[0];
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
  assert.match(
    (await invoke(node, { interaction: { id: plan.interactionId, decision: "approve" } })).message,
    /Unknown/,
  );
  await helper.unload();
  assert.throws(() => node.interaction.resume(plan, msg, { decision: "approve" }), /closed/);
  const fresh = await load({ decisions: [{ id: "different" }] });
  const output = once(helper.getNode("continued"));
  fresh.interaction.resume(plan, msg, { decision: "reject" });
  const result = await output;
  assert.deepEqual(result.payload, { order: 123 });
  assert.equal(result.before, 1);
  assert.deepEqual(result.interaction, { id: plan.interactionId, decision: "reject" });
  assert.equal(msg.interaction, undefined);
});

test("close drops local pending entries and host failures do not fall back", async () => {
  const node = await load();
  const requested = once(helper.getNode("requested"));
  await invoke(node, { payload: "original" });
  const {
    interaction: { id },
  } = await requested;
  await helper.unload();
  const fresh = await load();
  assert.match(
    (await invoke(fresh, { interaction: { id, decision: "approve" } })).message,
    /Unknown/,
  );
  await helper.unload();
  helper.settings({
    nodeRedAgentsInteractionHost: {
      version: 1,
      suspend() {
        throw new Error("checkpoint failed");
      },
    },
  });
  const failing = await load();
  assert.match((await invoke(failing, { payload: "start" })).message, /checkpoint failed/);
  await helper.unload();
  helper.settings({ nodeRedAgentsInteractionHost: { version: 2 } });
  const invalid = await load();
  assert.match((await invoke(invalid, {})).message, /version 1/);
});
