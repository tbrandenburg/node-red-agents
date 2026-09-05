"use strict";

const Ajv = require("ajv");

// Best-effort reask budget (issue #23): neither the opencode nor pi CLI has
// a --schema/--json-schema flag (verified against both CLIs' --help), so
// output_format is enforced entirely via prompt augmentation + post-hoc
// parsing/validation + a bounded number of "please retry" reask turns. This
// is a fixed constant, not per-node configurable, to keep the failure mode
// predictable (a run either produces valid structured output within this
// budget, or fails outright -- never silently degrades to raw text).
const STRUCTURED_OUTPUT_MAX_REASKS = 3;

// Compiles a JSON Schema (already-parsed object) into an AJV validate
// function. Never throws -- returns { error: <message> } instead, so a
// caller (agent.js, at deploy time) can surface a clean red node status
// ("invalid output_format schema: <msg>") rather than crashing Node-RED.
function compileOutputFormat(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { error: "output_format must be a JSON object (a JSON Schema)" };
  }
  try {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema);
    return { validate };
  } catch (err) {
    return { error: err.message };
  }
}

// Strips a single ```json ... ``` (or plain ``` ... ```) fence if present,
// otherwise returns the text unchanged -- models asked for "only JSON"
// still commonly wrap it in a markdown code fence.
function stripCodeFence(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match ? match[1] : text;
}

// Parses `text` to a plain object only (arrays/primitives at the top level
// are rejected -- output_format is an object-only contract). Returns
// undefined instead of throwing on any failure.
function parseObjectOnly(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return undefined;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : undefined;
}

// Tiered best-effort parse of an agent's raw text response into a JSON
// object matching output_format, per issue #23:
//   1. Strip a ```json fence if present.
//   2. Try a clean JSON.parse of the (fence-stripped) whole text.
//   3. If that fails, scan for the FIRST '{' (not the last -- avoids
//      grabbing a trailing example instead of the real payload) through
//      the last '}' and retry JSON.parse on that slice.
//   4. If that also fails, return undefined (no jsonrepair dependency --
//      shipped without it per the issue's own v1 allowance).
function tryParseStructuredOutput(text) {
  if (typeof text !== "string" || !text.trim()) return undefined;

  const candidate = stripCodeFence(text).trim();

  const clean = parseObjectOnly(candidate);
  if (clean !== undefined) return clean;

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return undefined;

  return parseObjectOnly(candidate.slice(firstBrace, lastBrace + 1));
}

// Appends a fixed instruction block asking the model for ONLY a JSON
// object matching `schema` (pretty-printed). Same functional intent as
// Archon's structured-output prompting, written independently.
function augmentPromptForSchema(prompt, schema) {
  return (
    `${prompt}\n\n` +
    "Respond with ONLY a single JSON object (no surrounding prose, no " +
    "markdown code fences) that validates against this JSON Schema:\n" +
    `${JSON.stringify(schema, null, 2)}`
  );
}

// Builds a reask prompt: the original prompt, the AJV validation errors
// from the previous (invalid) attempt, and the schema again.
function buildReaskPrompt(originalPrompt, schema, errors) {
  const errorLines = (errors || [])
    .map((e) => `- ${e.instancePath || "(root)"} ${e.message}`)
    .join("\n");
  return (
    `${originalPrompt}\n\n` +
    "Your previous response did not validate against the required JSON " +
    `Schema. Validation errors:\n${errorLines || "(response was not valid JSON)"}\n\n` +
    "Respond again with ONLY a single JSON object (no prose, no markdown " +
    `code fences) that validates against this schema:\n${JSON.stringify(schema, null, 2)}`
  );
}

module.exports = {
  STRUCTURED_OUTPUT_MAX_REASKS,
  compileOutputFormat,
  tryParseStructuredOutput,
  augmentPromptForSchema,
  buildReaskPrompt,
};
