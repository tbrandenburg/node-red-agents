"use strict";

const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { createSanitizer } = require("../../../../shared/cli-provider-auth");

function deferred() {
  let resolve;
  const promise = new Promise((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function harness() {
  const filename = require.resolve("../../agent-server");
  const realRequire = createRequire(filename);
  const children = [];
  const outputs = [];
  const spies = [];
  let port = 12345;
  const state = { key: "synthetic-first", failure: "", health: undefined, session: undefined };
  const dependencies = {
    "./lib/port": { findFreePort: async () => port++ },
    "../../shared/cli-provider-auth": {
      createSanitizer,
      resolveCLIAuth: () => {
        const redact = createSanitizer([state.key]);
        const spy = { calls: 0 };
        spies.push(spy);
        return {
          env: {},
          model: "",
          sanitize: (value) => {
            spy.calls++;
            return redact(value);
          },
        };
      },
    },
    "./lib/daemon": {
      spawnDaemon: ({ sanitize }) => {
        if (state.failure === "spawn") throw new Error(state.key);
        const child = new EventEmitter();
        child.exitCode = null;
        child.signalCode = null;
        child.sanitize = sanitize;
        children.push(child);
        return { child, diagnostics: {} };
      },
      waitForHealthy: async () => {
        if (state.health) await state.health.promise;
        if (state.failure === "health") throw new Error(state.key);
      },
      killDaemon: async (child) => {
        if (!child) return;
        child.exitCode = 0;
        child.emit("exit", 0);
      },
    },
    "./lib/http": {
      request: async (url) => {
        if (url.endsWith("/session")) {
          if (state.session) await state.session.promise;
          if (state.failure === "session") throw new Error(state.key);
          return { id: `session-${new URL(url).port}` };
        }
        if (state.response) await state.response.promise;
        if (state.failure === "message") throw new Error(state.key);
        return { parts: [{ type: "text", text: "reply" }] };
      },
    },
  };
  let Node;
  const RED = {
    nodes: {
      createNode: (node) => {
        const events = new EventEmitter();
        node.on = events.on.bind(events);
        node.emit = events.emit.bind(events);
        node.send = (value) => outputs.push(value);
        node.status = () => {};
        node.id = "server";
      },
      registerType: (_type, constructor) => {
        Node = constructor;
      },
    },
    util: { evaluateNodeProperty: (prop, type, _node, msg) => (type === "msg" ? msg[prop] : prop) },
  };
  const module = { exports: {} };
  vm.runInThisContext(`(function(require, module) {${fs.readFileSync(filename, "utf8")}\n})`, {
    filename,
  })((name) => dependencies[name] || realRequire(name), module);
  module.exports(RED);
  const node = new Node({ apiVersionMode: "v1" });
  const input = (msg) =>
    new Promise((resolve) => {
      const sent = [];
      node.emit(
        "input",
        msg,
        (value) => sent.push(value),
        (error) => resolve({ sent, error }),
      );
    });
  const close = () => new Promise((resolve) => node.emit("close", resolve));
  const status = async (text) => (await input({ operation: "status", text })).sent[0][0].text;
  return { node, state, children, outputs, spies, input, close, status };
}

module.exports = { harness, deferred };
