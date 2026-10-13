"use strict";

const { getProviderConfig } = require("./model-provider");
const { secretVariants } = require("./providers/safety");
const { createEventRedactor } = require("./cli-stream-redactor");

const mappings = {
  openrouter: { key: "OPENROUTER_API_KEY", url: "https://openrouter.ai/api/v1" },
  gateway: { key: "AI_GATEWAY_API_KEY", url: "https://ai-gateway.vercel.sh/v4/ai" },
};

function invalid(message) {
  return Object.assign(new Error(message), { code: "CLI_PROVIDER_AUTH" });
}

function createSanitizer(secrets = []) {
  const variants = secretVariants(secrets);
  const text = (value) =>
    variants
      .reduce((value, secret) => value.split(secret).join("[REDACTED]"), value)
      .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
  function clone(value, diagnostic = false) {
    const seen = new Map();
    const pending = [];
    function copy(value, depth) {
      if (typeof value === "string") return text(value);
      if (!value || typeof value !== "object") return value;
      if (diagnostic && (depth > 20 || seen.has(value))) return "[REDACTED]";
      if (seen.has(value)) return seen.get(value);
      if (value instanceof Date) return new Date(value.getTime());
      if (Buffer.isBuffer(value)) {
        const original = value.toString();
        const redacted = text(original);
        return redacted === original ? Buffer.from(value) : Buffer.from(redacted);
      }
      const result = Array.isArray(value) ? new Array(value.length) : {};
      seen.set(value, result);
      pending.push({ value, result, depth });
      return result;
    }
    const result = copy(value, 0);
    // Iterative traversal preserves deep application messages without consuming the call stack.
    for (let index = 0; index < pending.length; index++) {
      const { value, result, depth } = pending[index];
      for (const [key, entry] of Object.entries(value)) {
        Object.defineProperty(result, text(key), {
          value: copy(entry, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return result;
  }
  const sanitize = (value) => clone(value);
  sanitize.diagnostic = (value) => clone(value, true);
  sanitize.events = (emit) => createEventRedactor(sanitize.diagnostic, variants, emit);
  return sanitize;
}

function resolveCLIAuth(
  RED,
  { authMode = "default", modelProvider, agent, model = "" },
  environment = process.env,
) {
  if (!["default", "provider", "environment"].includes(authMode)) {
    throw invalid("Choose default, provider or environment CLI authentication");
  }
  const env = { ...environment };
  const secrets = Object.entries(env)
    .filter(([key]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/.test(key))
    .map(([, value]) => value);
  const result = (selected = model, cliProvider) => {
    const sanitize = createSanitizer(secrets);
    return {
      env,
      model: selected,
      cliProvider,
      sanitize,
      safeError: (error) =>
        Object.assign(new Error(sanitize(error.message || String(error))), {
          ...(error.code ? { code: error.code } : {}),
        }),
    };
  };
  if (authMode === "default") return result();
  const opencode = ["opencode", "opencode-v1", "opencode-v2"].includes(agent);
  if (!opencode && agent !== "pi")
    throw invalid("CLI provider authentication is unsupported for this agent (including Copilot)");
  if (typeof model !== "string") throw invalid("CLI provider model must be a string");
  function cliID(provider) {
    if (provider === "openrouter") return "openrouter";
    if (provider === "gateway" && agent === "pi") return "vercel-ai-gateway";
    if (provider === "gateway" && agent === "opencode-v1") return "vercel";
    throw invalid(
      "Unsupported CLI/provider combination; Gateway requires Pi or explicit OpenCode v1",
    );
  }
  if (authMode === "environment") {
    // Explicit provider-prefixed model selects the allowlisted ambient key.
    const prefix = model.split("/")[0];
    const provider =
      prefix === "openrouter"
        ? "openrouter"
        : prefix === "vercel" || prefix === "vercel-ai-gateway"
          ? "gateway"
          : undefined;
    if (!provider || prefix !== cliID(provider) || !model.slice(prefix.length + 1)) {
      throw invalid("Environment authentication requires a supported CLI provider/model");
    }
    if (!env[mappings[provider].key]?.trim())
      throw invalid("Required CLI provider environment credential is missing");
    return result(model, prefix);
  }
  const config = getProviderConfig(RED, modelProvider);
  secrets.push(config.apiKey);
  const prefix = cliID(config.provider);
  if (config.baseURL !== mappings[config.provider].url) {
    throw invalid("Custom model-provider URLs are unsupported for CLI authentication");
  }
  const selected = model ? model.slice(prefix.length + 1) : config.defaultModel;
  if (model && !model.startsWith(`${prefix}/`)) {
    throw invalid("CLI model provider must match the selected model-provider");
  }
  if (!selected || (selected !== config.defaultModel && !config.allowedModels.includes(selected))) {
    throw invalid("Select a default model or an allowed model from the model-provider");
  }
  env[mappings[config.provider].key] = config.apiKey;
  return result(`${prefix}/${selected}`, prefix);
}

module.exports = { resolveCLIAuth, createSanitizer };
