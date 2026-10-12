"use strict";

const defaults = Object.freeze({
  openrouter: "https://openrouter.ai/api/v1",
  gateway: "https://ai-gateway.vercel.sh/v4/ai",
});

function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_PROVIDER_CONFIG";
  return error;
}

function url(value) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw invalid("Provider URLs require HTTPS without credentials, query or fragment");
    }
    return parsed.href.replace(/\/+$/, "");
  } catch {
    throw invalid("Provider URL must be an HTTPS URL without credentials, query or fragment");
  }
}

function model(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
    throw invalid("Model must be a non-empty model ID (up to 200 characters)");
  }
  return value;
}

function validateConfig(config, settings = {}) {
  if (!config || typeof config !== "object") throw invalid("Provider configuration is required");
  if (!Object.hasOwn(defaults, config.provider))
    throw invalid("Choose openrouter or gateway provider");
  const timeout = Number(config.timeout ?? 60000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600000) {
    throw invalid("Timeout must be an integer from 1 to 600000 milliseconds");
  }
  const trusted = settings.nodeRedAgentsModelProvider?.allowedBaseURLs ?? [];
  if (!Array.isArray(trusted) || trusted.some((entry) => typeof entry !== "string")) {
    throw invalid("Admin allowedBaseURLs must be an array of HTTPS URLs");
  }
  const allowed = new Set(trusted.map(url));
  function trustedURL(value, builtin) {
    const normalized = url(value || builtin);
    if (normalized !== builtin && !allowed.has(normalized)) {
      throw invalid("Custom provider URL is not in the admin allowedBaseURLs setting");
    }
    return normalized;
  }
  const baseURL = trustedURL(config.baseURL, defaults[config.provider]);
  if (config.provider === "gateway" && config.decisionsBaseURL) {
    throw invalid("decisionsBaseURL is only supported for openrouter");
  }
  const decisionsBaseURL =
    config.provider === "openrouter"
      ? trustedURL(
          config.decisionsBaseURL ||
            (baseURL.endsWith("/v1") ? baseURL.slice(0, -3) + "/alpha" : ""),
          "https://openrouter.ai/api/alpha",
        )
      : undefined;
  if (config.provider === "openrouter" && !baseURL.endsWith("/v1") && !config.decisionsBaseURL) {
    throw invalid("Custom OpenRouter baseURL without /v1 requires decisionsBaseURL");
  }
  const defaultModel =
    config.defaultModel == null || config.defaultModel === "" ? "" : model(config.defaultModel);
  if (config.allowedModels != null && typeof config.allowedModels !== "string") {
    throw invalid("Allowed models must be comma or newline separated model IDs");
  }
  const allowedModels = (config.allowedModels || "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(model);
  return Object.freeze({
    provider: config.provider,
    baseURL,
    decisionsBaseURL,
    defaultModel,
    timeout,
    allowedModels: Object.freeze(allowedModels),
  });
}

function resolveModel(config, requested) {
  const selected = model(requested == null || requested === "" ? config.defaultModel : requested);
  if (selected !== config.defaultModel && !config.allowedModels.includes(selected)) {
    throw invalid("Model override is not in the configured allowed models");
  }
  return selected;
}

module.exports = { validateConfig, resolveModel };
