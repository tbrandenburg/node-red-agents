"use strict";

const Ajv = require("ajv");
const ajv = new Ajv({ strict: true, allErrors: true });

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_MODEL_INPUT" });
}

function evaluate(RED, node, msg, value, type) {
  if (!["str", "msg", "flow", "global", "json", "jsonata"].includes(type)) {
    throw invalid("Unsupported input type");
  }
  return new Promise((resolve, reject) => {
    RED.util.evaluateNodeProperty(value, type, node, msg, (error, result) => {
      if (error) return reject(invalid("Cannot evaluate model input"));
      resolve(result);
    });
  });
}

async function input(RED, node, config, msg) {
  const operation = config.operation || "generate";
  if (!["generate", "structured", "embed"].includes(operation)) {
    throw invalid("Select generate, structured or embed");
  }
  const value = await evaluate(
    RED,
    node,
    msg,
    config.input ?? "payload",
    config.inputType || "msg",
  );
  const mode = config.inputMode || "prompt";
  if (!["prompt", "messages"].includes(mode)) throw invalid("Select prompt or messages");
  if (operation === "embed" && mode !== "prompt") throw invalid("Embedding requires text input");
  const prompt = mode === "prompt";
  if (prompt && (typeof value !== "string" || !value.trim())) {
    throw invalid("Model input must be non-empty text");
  }
  if (
    !prompt &&
    (!Array.isArray(value) ||
      !value.length ||
      value.some(
        (entry) =>
          !entry ||
          !["system", "user", "assistant"].includes(entry.role) ||
          typeof entry.content !== "string" ||
          !entry.content.trim(),
      ))
  )
    throw invalid("Messages require system, user or assistant roles and text content");
  const model = msg.model === undefined ? config.model : msg.model;
  if (model !== undefined && typeof model !== "string") throw invalid("Model must be an ID string");
  const timeout =
    config.timeout === undefined || config.timeout === "" ? 0 : Number(config.timeout);
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 600000) {
    throw invalid("Timeout must be 0–600000 milliseconds");
  }
  if (operation === "embed" && config.streaming)
    throw invalid("Embedding does not support streaming");
  let validate;
  let schema;
  if (operation === "structured") {
    try {
      schema = typeof config.schema === "string" ? JSON.parse(config.schema) : config.schema;
      if (
        !schema ||
        typeof schema !== "object" ||
        Array.isArray(schema) ||
        schema.type !== "object"
      ) {
        throw invalid("Structured schema must describe an object");
      }
      validate = ajv.compile(schema);
    } catch {
      throw invalid("Invalid structured JSON schema (draft-07 object required)");
    }
  }
  return {
    operation,
    model,
    timeout,
    schema,
    validate,
    prompt: prompt
      ? { prompt: value }
      : {
          allowSystemInMessages: true,
          messages: value.map(({ role, content }) => ({ role, content })),
        },
    value,
  };
}

module.exports = { input, invalid };
