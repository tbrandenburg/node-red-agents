"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
// Node-RED supplies cheerio in the installed workspace used by its test helper.
const cheerio = createRequire(require.resolve("node-red-node-test-helper/package.json"))("cheerio");
const html = fs.readFileSync(path.join(__dirname, "../agent.html"), "utf8");
const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
const template = html.match(
  /<script type="text\/html" data-template-name="agent">([\s\S]*?)<\/script>/,
)[1];
const fixture = {
  retrieved: "2026-01-02",
  providers: [
    ["github-copilot", "GitHub Copilot", [["copilot-model", "2025-01-01"]]],
    [
      "openrouter",
      "OpenRouter <img>",
      [
        ["upstream/nested", "2025-04-02"],
        ["same-a", "2025-04-02"],
        ["same-b", "2025-04-02"],
        ["month", "2025-04"],
        ["undated", ""],
      ],
    ],
    ["vercel", "Vercel", [["vendor/gateway-model", "2025-01-01"]]],
  ],
};

// The widget shims model the Node-RED APIs; the registration and callbacks are
// the actual code in agent.html. Browser acceptance separately exercises the real widget.
function editor(snapshot = fixture, initial = {}) {
  const $ = cheerio.load(template);
  const prototype = Object.getPrototypeOf($("input"));
  const handlers = new WeakMap();
  prototype.on = function (event, handler) {
    this.each((_, el) => {
      const events = handlers.get(el) || {};
      (events[event] ||= []).push(handler);
      handlers.set(el, events);
    });
    return this;
  };
  prototype.trigger = function (event) {
    this.each((_, el) =>
      (handlers.get(el)?.[event] || []).forEach((fn) => fn.call(el, { type: event })),
    );
    return this;
  };
  prototype.typedInput = function (option, value) {
    const el = this.first();
    if (typeof option === "object") {
      el.data("type", $(option.typeField).val() || option.types[0]);
      el.attr("type", "hidden");
      el.after('<span><input type="text" class="red-ui-typedInput-input"></span>');
      const visible = el.parent().find("input.red-ui-typedInput-input");
      visible.val(el.val());
      visible.on("change", () => {
        el.val(visible.val());
        el.trigger("change");
      });
      return this;
    }
    if (option === "type" && value === undefined) return el.data("type");
    if (option === "value" && value === undefined) return el.val();
    if (option === "type") {
      el.data("type", value);
      $("#node-input-modelType").val(value);
      el.trigger("change");
    }
    if (option === "value") {
      el.val(value);
      el.parent().find("input.red-ui-typedInput-input").val(value);
      el.trigger("change");
    }
    return this;
  };
  prototype.editableList = function (option) {
    return option === "items" ? $() : this;
  };
  prototype.toggle = function () {
    return this;
  };
  let definition;
  const RED = {
    nodes: {
      registerType: (_name, value) => {
        definition = value;
      },
    },
    validators: { number: () => () => true },
    popover: { create: () => {} },
  };
  const source = script.replace(
    /const MODEL_CATALOG = \{[^\n]*\};/,
    `const MODEL_CATALOG = ${JSON.stringify(snapshot).replace(/</g, "\\u003c")};`,
  );
  vm.runInNewContext(source, { RED, $ });
  const node = {
    mcpServers: [],
    allowedTools: [],
    deniedTools: [],
    promptArgs: [],
    srtAllowedDomains: [],
    srtAllowedWriteDirs: [],
    ...initial,
  };
  $("#node-input-model").val(node.model || "");
  $("#node-input-modelType").val(node.modelType || "str");
  $("#node-input-agent").val(node.agent || "opencode-v2");
  definition.oneditprepare.call(node);
  return { $, definition, node };
}
function values($, selector) {
  return $(selector)
    .map((_, el) => $(el).val())
    .get();
}

test("fixed OpenCode suggestions stay available without changing saved values or other agents", () => {
  for (const agent of ["opencode", "opencode-v1", "opencode-v2"]) {
    const { $ } = editor(fixture, { agent, model: "custom/model#variant", modelType: "str" });
    const input = $("#node-input-model");
    assert.equal($("#agent-catalog-provider option").first().text(), "Fixed models (OpenCode)");
    assert.deepEqual(values($, "#agent-model-suggestions option"), [
      "opencode/big-pickle",
      "opencode/iceman-free",
      "opencode/minimax-m3.1-flash-free",
    ]);
    assert.equal(input.typedInput("value"), "custom/model#variant");
    input.typedInput("type", "flow");
    assert.equal($("#agent-model-suggestions option").length, 0);
    assert.equal(input.typedInput("value"), "custom/model#variant");
    input.typedInput("type", "str");
    assert.equal($("#agent-model-suggestions option").first().val(), "opencode/big-pickle");
    $("#node-input-agent").val("pi").trigger("change");
    assert.equal($("#agent-model-suggestions option").length, 0);
    assert.equal(input.typedInput("value"), "custom/model#variant");
    $("#node-input-agent").val("copilot").trigger("change");
    assert.deepEqual(values($, "#agent-model-suggestions option"), ["copilot-model"]);
    assert.equal(input.typedInput("value"), "custom/model#variant");
  }
});

test("choosing a fixed model updates the string value through the visible input", () => {
  const { $ } = editor(fixture, { agent: "opencode-v2", model: "custom/old", modelType: "str" });
  const input = $("#node-input-model");
  assert.equal(input.typedInput("value"), "custom/old");
  input
    .parent()
    .find("input.red-ui-typedInput-input")
    .val($("#agent-model-suggestions option").first().val())
    .trigger("change");
  assert.equal(input.typedInput("value"), "opencode/big-pickle");
  assert.equal(input.typedInput("type"), "str");
});

test("registered editor filters catalog by provider and maps nested OpenCode, Copilot and Pi IDs", () => {
  const { $, definition, node } = editor(fixture, {
    model: "custom/old#variant",
    modelType: "str",
  });
  assert.equal(Object.hasOwn(definition.defaults, "catalogProvider"), false);
  assert.equal($("#agent-catalog-date").text(), "2026-01-02");
  assert.deepEqual(values($, "#agent-catalog-provider option"), [
    "",
    "github-copilot",
    "openrouter",
    "vercel",
  ]);
  $("#agent-catalog-provider").val("openrouter").trigger("change");
  assert.deepEqual(values($, "#agent-model-suggestions option"), [
    "openrouter/upstream/nested",
    "openrouter/same-a",
    "openrouter/same-b",
    "openrouter/month",
    "openrouter/undated",
  ]);
  assert.equal($("#agent-model-suggestions option").last().text(), "date unknown");
  assert.equal($("#agent-catalog-provider option").eq(2).text(), "OpenRouter <img> (openrouter)");
  assert.equal($("#agent-catalog-provider img").length, 0);
  $("#node-input-agent").val("copilot").trigger("change");
  assert.deepEqual(values($, "#agent-catalog-provider option"), ["", "github-copilot"]);
  assert.deepEqual(values($, "#agent-model-suggestions option"), ["copilot-model"]);
  $("#node-input-agent").val("pi").trigger("change");
  $("#agent-catalog-provider").val("vercel").trigger("change");
  assert.deepEqual(values($, "#agent-model-suggestions option"), [
    "vercel-ai-gateway/vendor/gateway-model",
  ]);
  assert.equal($("#node-input-model").typedInput("value"), "custom/old#variant");
  assert.equal(node.model, "custom/old#variant");
});

test("typed paths remain unchanged, no datalist is attached outside str, and sessions do not share options", () => {
  const first = editor(fixture, { model: "stored.value", modelType: "msg" });
  const $ = first.$;
  const input = $("#node-input-model");
  const visible = input.parent().find("input.red-ui-typedInput-input");
  assert.equal(input.attr("type"), "hidden");
  for (const type of ["msg", "flow", "global", "env"]) {
    input.typedInput("type", type);
    $("#agent-catalog-provider").val("openrouter").trigger("change");
    assert.equal(input.typedInput("type"), type);
    assert.equal(input.typedInput("value"), "stored.value");
    assert.equal(visible.attr("list"), undefined);
    assert.equal($("#agent-model-suggestions option").length, 0);
  }
  input.typedInput("type", "str");
  assert.equal(visible.attr("list"), "agent-model-suggestions");
  assert.equal(input.attr("list"), undefined);
  assert.equal($("#agent-model-suggestions option").length, 5);
  $("#agent-catalog-provider").val("vercel").trigger("change");
  assert.equal($("#agent-model-suggestions option").length, 1);
  assert.equal(input.typedInput("value"), "stored.value");
  const reopened = editor(fixture, { model: "stored.value", modelType: "flow" });
  assert.equal(reopened.$("#agent-model-suggestions").length, 1);
  assert.equal(reopened.$("#agent-model-suggestions option").length, 0);
  assert.equal(reopened.$("#node-input-model").typedInput("value"), "stored.value");
  assert.equal(reopened.$("#node-input-model").typedInput("type"), "flow");
});

test("checked-in snapshot registers and keeps suggestions bounded without changing a blank model", () => {
  const match = script.match(/const MODEL_CATALOG = (\{[^\n]*\});/);
  const snapshot = JSON.parse(match[1]);
  const { $ } = editor(snapshot);
  const provider = snapshot.providers.find((entry) => entry[2].length === 10);
  assert.ok(provider);
  $("#agent-catalog-provider").val(provider[0]).trigger("change");
  assert.equal($("#agent-model-suggestions option").length, 10);
  assert.equal($("#node-input-model").typedInput("value"), "");
});

test("choosing an option updates the model through the visible input, not the credential provider", () => {
  const { $ } = editor(fixture, { model: "previous", modelType: "str" });
  $("#node-input-modelProvider").val("credential-config-id");
  $("#agent-catalog-provider").val("openrouter").trigger("change");
  const input = $("#node-input-model");
  assert.equal(input.typedInput("value"), "previous");
  input
    .parent()
    .find("input.red-ui-typedInput-input")
    .val($("#agent-model-suggestions option").first().val())
    .trigger("change");
  assert.equal(input.typedInput("value"), "openrouter/upstream/nested");
  assert.equal(input.typedInput("type"), "str");
  assert.equal($("#node-input-modelProvider").val(), "credential-config-id");
});
