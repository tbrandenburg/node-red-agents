#!/usr/bin/env node
"use strict";

// Release-time snapshot of https://models.dev/api.json?type=chat; never loaded at runtime.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const URL = "https://models.dev/api.json?type=chat";
const MAX_BYTES = 12 * 1024 * 1024;
const BEGIN = "    // BEGIN MODEL CATALOG";
const END = "    // END MODEL CATALOG";
const target = path.join(__dirname, "../packages/node-red-agents/nodes/agent/agent.html");

class UpstreamError extends Error {}

function dateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}(?:-\d{2})?$/.test(value)) return "";
  const parts = value.split("-").map(Number);
  const day = parts[2] ?? 1;
  if (day === 0) return "";
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, day));
  if (
    date.getUTCFullYear() !== parts[0] ||
    date.getUTCMonth() !== parts[1] - 1 ||
    date.getUTCDate() !== day
  )
    return "";
  return value.length === 7 ? `${value}-00` : value;
}
function compare(a, b) {
  const dates = dateKey(b[1]).localeCompare(dateKey(a[1]));
  return dates || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}
function specialized(model) {
  // These identifiers identify encoder/classifier families, not chat capabilities.
  return (
    /(?:^|\/)gliner(?:\d|[-.])/i.test(model.id) ||
    /(?:^|\/)brick-complexity-pro$/i.test(model.id) ||
    /^embedding model for semantic search, retrieval, clustering, and ranking pipelines\.?$/i.test(
      (model.description || "").trim(),
    ) ||
    /^embedding-only model\b/i.test((model.description || "").trim())
  );
}
function project(data, retrieved) {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new UpstreamError("catalog is not an object");
  const providers = [];
  for (const [id, provider] of Object.entries(data).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (
      !id ||
      !provider ||
      typeof provider.name !== "string" ||
      !provider.name ||
      !provider.models ||
      typeof provider.models !== "object" ||
      Array.isArray(provider.models)
    )
      throw new UpstreamError("invalid provider");
    const models = Object.entries(provider.models)
      .map(([key, model]) => {
        if (
          !key ||
          !model ||
          typeof model !== "object" ||
          typeof model.id !== "string" ||
          model.id !== key ||
          (model.release_date != null && typeof model.release_date !== "string") ||
          (model.type != null && typeof model.type !== "string") ||
          (model.description != null && typeof model.description !== "string")
        )
          throw new UpstreamError("invalid model");
        // Untyped models default to chat upstream; exclude only high-confidence exceptions.
        if ((model.type != null && model.type !== "chat") || specialized(model)) return null;
        return [model.id, model.release_date || ""];
      })
      .filter(Boolean)
      .sort(compare)
      .slice(0, 10);
    if (models.length) providers.push([id, provider.name, models]);
  }
  if (!providers.length) throw new UpstreamError("catalog has no models");
  return { retrieved, providers };
}
function validateSnapshot(snapshot) {
  if (
    !snapshot ||
    !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.retrieved) ||
    !dateKey(snapshot.retrieved) ||
    !Array.isArray(snapshot.providers) ||
    !snapshot.providers.length
  )
    throw new Error("invalid prior catalog snapshot");
  let previous = "";
  for (const provider of snapshot.providers) {
    if (
      !Array.isArray(provider) ||
      provider.length !== 3 ||
      typeof provider[0] !== "string" ||
      !provider[0] ||
      provider[0] <= previous ||
      typeof provider[1] !== "string" ||
      !provider[1] ||
      !Array.isArray(provider[2]) ||
      !provider[2].length ||
      provider[2].length > 10
    )
      throw new Error("invalid prior catalog provider");
    previous = provider[0];
    const ids = new Set();
    for (const [index, model] of provider[2].entries()) {
      if (
        !Array.isArray(model) ||
        model.length !== 2 ||
        typeof model[0] !== "string" ||
        !model[0] ||
        typeof model[1] !== "string" ||
        ids.has(model[0]) ||
        (index && compare(provider[2][index - 1], model) > 0)
      )
        throw new Error("invalid prior catalog model");
      ids.add(model[0]);
    }
  }
}
function markers(html) {
  const found = [
    ...html.matchAll(/(?:^|\n)( {4}\/\/ (?:BEGIN|END) MODEL CATALOG)(?=\r?\n|(?![\s\S]))/g),
  ];
  if (found.length !== 2 || found[0][1] !== BEGIN || found[1][1] !== END)
    throw new Error("expected exactly one catalog marker pair");
  const start = found[0].index + found[0][0].length - BEGIN.length;
  const end = found[1].index + found[1][0].length;
  return { start, end };
}
function parseSnapshot(block) {
  const match = block.match(
    /^ {4}\/\/ BEGIN MODEL CATALOG\r?\n {4}\/\/ prettier-ignore\r?\n {4}const MODEL_CATALOG = (\{[^\r\n]*\});\r?\n {4}\/\/ END MODEL CATALOG$/,
  );
  if (!match) throw new Error("missing prior catalog snapshot");
  if (/[<\u2028\u2029]/.test(match[1])) throw new Error("unsafe prior catalog serialization");
  const snapshot = JSON.parse(match[1]);
  validateSnapshot(snapshot);
  return snapshot;
}
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);
function networkError(error, signal) {
  if (
    (signal.aborted && (error?.name === "TimeoutError" || error?.name === "AbortError")) ||
    NETWORK_CODES.has(error?.code) ||
    NETWORK_CODES.has(error?.cause?.code)
  )
    return new UpstreamError(`network/timeout: ${error.message}`);
  return error;
}
async function readSource(input, request = fetch, timeout = 20000) {
  let bytes;
  if (input) {
    bytes = await fs.readFile(input);
    if (bytes.length > MAX_BYTES) throw new UpstreamError("response exceeds size limit");
  } else {
    let response;
    const signal = AbortSignal.timeout(timeout);
    try {
      response = await request(URL, {
        signal,
        redirect: "manual",
      });
    } catch (error) {
      throw networkError(error, signal);
    }
    if (
      !response ||
      typeof response.ok !== "boolean" ||
      !response.headers ||
      typeof response.headers.get !== "function"
    )
      throw new Error("invalid fetch response");
    if (!response.ok) throw new UpstreamError(`HTTP ${response.status}`);
    if (!response.body || typeof response.body[Symbol.asyncIterator] !== "function")
      throw new Error("invalid fetch response body");
    if (Number(response.headers.get("content-length")) > MAX_BYTES)
      throw new UpstreamError("response exceeds size limit");
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new UpstreamError("response exceeds size limit");
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw networkError(error, signal);
    }
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new UpstreamError(`invalid JSON: ${error.message}`);
  }
}
async function refresh(options = {}) {
  const file = options.target || target;
  const html = await fs.readFile(file, "utf8");
  const range = markers(html);
  let snapshot;
  try {
    snapshot = project(
      await readSource(options.input, options.request, options.timeout),
      options.date || new Date().toISOString().slice(0, 10),
    );
    validateSnapshot(snapshot);
  } catch (error) {
    if (!(error instanceof UpstreamError) || !options.fallback) throw error;
    const previous = parseSnapshot(html.slice(range.start, range.end));
    console.error(
      `WARNING: model catalog refresh failed (${error.message}); retaining stale snapshot from ${previous.retrieved}.`,
    );
    return previous;
  }
  const json = JSON.stringify(snapshot)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const newline = html.startsWith("\r\n", range.start + BEGIN.length) ? "\r\n" : "\n";
  const replacement = [
    BEGIN,
    "    // prettier-ignore",
    `    const MODEL_CATALOG = ${json};`,
    END,
  ].join(newline);
  const result = html.slice(0, range.start) + replacement + html.slice(range.end);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    const mode = (await fs.stat(file)).mode;
    await fs.writeFile(tmp, result, { flag: "wx", mode });
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return snapshot;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const fallback = args.includes("--fallback");
  const inputIndex = args.indexOf("--input");
  if (
    args.some(
      (arg, index) =>
        arg !== "--fallback" && arg !== "--input" && (inputIndex < 0 || index !== inputIndex + 1),
    ) ||
    (inputIndex >= 0 && (!args[inputIndex + 1] || args[inputIndex + 1].startsWith("--")))
  ) {
    console.error("usage: node scripts/model-catalog.js [--fallback] [--input fixture.json]");
    process.exitCode = 1;
  } else {
    refresh({ fallback, input: inputIndex < 0 ? undefined : args[inputIndex + 1] })
      .then((snapshot) =>
        console.log(
          `Model catalog snapshot: ${snapshot.retrieved}, ${snapshot.providers.length} providers`,
        ),
      )
      .catch((error) => {
        console.error(`model catalog: ${error.message}`);
        process.exitCode = 1;
      });
  }
}
module.exports = { refresh, project, dateKey, compare, validateSnapshot, UpstreamError };
