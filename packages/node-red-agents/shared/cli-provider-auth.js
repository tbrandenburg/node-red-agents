"use strict";

const { getProviderConfig } = require("./model-provider");

const mappings = {
  openrouter: { key: "OPENROUTER_API_KEY", url: "https://openrouter.ai/api/v1" },
  gateway: { key: "AI_GATEWAY_API_KEY", url: "https://ai-gateway.vercel.sh/v4/ai" },
};

function invalid(message) {
  return Object.assign(new Error(message), { code: "CLI_PROVIDER_AUTH" });
}

function createSanitizer(secrets = []) {
  const variants = [
    ...new Set(
      secrets
        .filter(Boolean)
        .flatMap((secret) => [
          secret,
          encodeURIComponent(secret),
          Buffer.from(secret).toString("base64"),
          JSON.stringify(secret).slice(1, -1),
        ]),
    ),
  ].sort((a, b) => b.length - a.length);
  function sanitize(value) {
    if (typeof value === "string") {
      return variants
        .reduce((text, secret) => text.split(secret).join("[REDACTED]"), value)
        .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
    }
    if (value instanceof Date) return new Date(value.getTime());
    if (Buffer.isBuffer(value)) {
      const text = value.toString();
      const redacted = sanitize(text);
      return redacted === text ? Buffer.from(value) : Buffer.from(redacted);
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        sanitize(key),
        /^(env|authorization|headers|api[_-]?key|password|token|secret)$/i.test(key)
          ? "[REDACTED]"
          : sanitize(entry),
      ]),
    );
  }
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
