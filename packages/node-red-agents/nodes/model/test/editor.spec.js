"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test(
  "editor declares provider reference, typed input, operations and final/events ordering",
  { timeout: 2000 },
  () => {
    const html = fs.readFileSync(path.join(__dirname, "../model.html"), "utf8");
    let registration;
    vm.runInNewContext(html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1], {
      RED: {
        nodes: {
          registerType: (name, definition) => {
            registration = { name, definition };
          },
        },
      },
    });
    assert.equal(registration.name, "model");
    const { definition } = registration;
    assert.equal(definition.inputs, 1);
    assert.equal(definition.outputs, 2);
    assert.equal(definition.defaults.provider.type, "model-provider");
    assert.deepEqual(Array.from(definition.outputLabels), ["Final result", "Stream events"]);
    for (const operation of ["generate", "structured", "embed"])
      assert.ok(definition.defaults.operation.validate(operation));
    assert.equal(definition.defaults.operation.validate("tool"), false);
    assert.match(html, /typedInput/);
    assert.match(html, /data-help-name="model"/);
    assert.match(html, /msg\.modelResult/);
    const svg = fs.readFileSync(path.join(__dirname, "../icons", definition.icon), "utf8");
    assert.match(svg, /width="40" height="60"/);
    assert.match(svg, /stroke="white"/);
  },
);

test(
  "importable example has generation, structured, streaming, embedding and scoped Catch",
  { timeout: 2000 },
  () => {
    const flow = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../examples/model.json"), "utf8"),
    );
    const ids = new Set(flow.map((node) => node.id));
    assert.equal(ids.size, flow.length);
    const models = flow.filter((node) => node.type === "model");
    assert.equal(models.length, 4);
    assert.deepEqual(
      models.map((node) => node.operation),
      ["generate", "structured", "generate", "embed"],
    );
    assert.ok(models.some((node) => node.streaming));
    assert.deepEqual(
      flow.find((node) => node.type === "catch").scope,
      models.map((node) => node.id),
    );
    for (const node of flow) {
      for (const output of node.wires || []) for (const id of output) assert.ok(ids.has(id));
      assert.equal(node.credentials, undefined);
      assert.equal(node.apiKey, undefined);
    }
  },
);
