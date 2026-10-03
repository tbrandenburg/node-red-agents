"use strict";

const { randomUUID } = require("node:crypto");

const DEFAULT_DECISIONS = [
  { id: "approve", label: "Approve" },
  { id: "reject", label: "Reject" },
];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function string(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function decisions(value = DEFAULT_DECISIONS) {
  if (!Array.isArray(value) || !value.length) {
    throw new Error("At least one decision is required");
  }
  const ids = new Set();
  return value.map((choice) => {
    object(choice, "Decision");
    if (typeof choice.id !== "string" || !SAFE_ID.test(choice.id) || ids.has(choice.id)) {
      throw new Error("Decision IDs must be unique and match [A-Za-z0-9][A-Za-z0-9._-]*");
    }
    ids.add(choice.id);
    if (choice.label !== undefined && typeof choice.label !== "string") {
      throw new Error("Decision label must be a string");
    }
    return { id: choice.id, label: choice.label || choice.id };
  });
}

function mode(msg) {
  object(msg, "Message");
  if (msg.interaction === undefined) return "request";
  object(msg.interaction, "Interaction");
  if (msg.interaction.status === "pending" && msg.interaction.decision === undefined) {
    throw new Error("Pending Request loopback requires a decision");
  }
  string(msg.interaction.id, "Interaction id");
  string(msg.interaction.decision, "Interaction decision");
  return "resolve";
}

function validatePlan(plan, node) {
  object(plan, "Interaction plan");
  if (plan.version !== 1 || plan.nodeId !== node.id || typeof plan.nodeName !== "string") {
    throw new Error("Invalid interaction plan version or node identity");
  }
  string(plan.interactionId, "Interaction id");
  string(plan.prompt, "Prompt");
  if (!Array.isArray(plan.decisions)) throw new Error("Plan decisions must be an array");
  return decisions(plan.decisions);
}

function response(plan, value, node) {
  const choices = validatePlan(plan, node);
  object(value, "Interaction response");
  if (!choices.some((choice) => choice.id === value.decision)) {
    throw new Error("Undeclared interaction decision");
  }
  if (value.text !== undefined && typeof value.text !== "string") {
    throw new Error("Interaction text must be a string");
  }
  return {
    id: plan.interactionId,
    decision: value.decision,
    ...(value.text === undefined ? {} : { text: value.text }),
  };
}

async function plan(RED, node, config, msg) {
  if (mode(msg) !== "request") throw new Error("Planning requires an ordinary request message");
  const choices = decisions(config.decisions);
  const prompt = await new Promise((resolve, reject) => {
    RED.util.evaluateNodeProperty(
      config.prompt,
      config.promptType || "str",
      node,
      msg,
      (err, value) => {
        if (err) return reject(err);
        resolve(value);
      },
    );
  });
  return {
    version: 1,
    interactionId: randomUUID(),
    nodeId: node.id,
    nodeName: node.name,
    prompt: string(prompt, "Prompt"),
    decisions: choices,
  };
}

module.exports = { decisions, mode, object, plan, response };
