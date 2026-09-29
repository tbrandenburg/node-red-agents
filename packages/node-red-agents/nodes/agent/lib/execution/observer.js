"use strict";

const { randomUUID } = require("node:crypto");

const INVENTORY_TIMEOUT_MS = 1000;
const ACK_TIMEOUT_MS = 60000;

function inputRecord(resolved) {
  return resolved.invocation === "prompt"
    ? { invocation: "prompt", prompt: resolved.prompt }
    : { invocation: resolved.invocation, name: resolved.invocationName, args: resolved.args };
}

function bounded(callback, record, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = "OBSERVER_TIMEOUT";
      reject(error);
    }, timeoutMs);
    Promise.resolve()
      .then(() => callback(record))
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

function inventoryNotice(callback, record, warn) {
  if (typeof callback !== "function") return;
  // At most two attempts per notice. A timed-out callback is not retried:
  // its remote side may still complete and must deduplicate by eventId.
  bounded(callback, record, INVENTORY_TIMEOUT_MS, record.type).catch((error) => {
    if (error.code === "OBSERVER_TIMEOUT") {
      warn(`${record.type} notice failed: ${error.message}`);
      return;
    }
    bounded(callback, record, INVENTORY_TIMEOUT_MS, record.type).catch((retryError) => {
      warn(`${record.type} notice failed: ${retryError.message}`);
    });
  });
}

function lifecycleRecord(type, node, deploymentId, fields = {}) {
  return {
    version: 1,
    type,
    eventId: randomUUID(),
    nodeId: node.id,
    deploymentId,
    agent: node.agent,
    agentName: node.name || "",
    timestamp: new Date().toISOString(),
    ...fields,
  };
}

module.exports = { ACK_TIMEOUT_MS, bounded, inputRecord, inventoryNotice, lifecycleRecord };
