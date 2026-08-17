"use strict";

// A minimal stand-in for the subset of the Node-RED runtime API that
// gh.js touches (RED.nodes.createNode/registerType, RED.util.evaluateNodeProperty,
// node.status/on). This repo doesn't depend on node-red-node-test-helper,
// so this is deliberately just enough to exercise gh.js's logic directly.
const { EventEmitter } = require("events");

function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function makeFakeRED() {
  let registered = null;

  const RED = {
    nodes: {
      createNode(node, config) {
        EventEmitter.call(node);
        Object.setPrototypeOf(Object.getPrototypeOf(node), EventEmitter.prototype);
        node.id = "test-node-id";
        node.name = config.name;
        node.statusHistory = [];
        node.status = (s) => {
          node.statusHistory.push(s);
          node.lastStatus = s;
        };
      },
      registerType(type, ctor) {
        registered = { type, ctor };
      },
    },
    util: {
      evaluateNodeProperty(value, type, node, msg) {
        if (type === "str") return value;
        if (type === "msg") return getByPath(msg, value);
        if (type === "flow" || type === "global") return undefined; // not needed for these tests
        throw new Error("fake-red: unsupported type " + type);
      },
    },
    validators: {
      number: () => () => true,
    },
  };

  return {
    RED,
    getRegistered: () => registered,
  };
}

module.exports = { makeFakeRED };
