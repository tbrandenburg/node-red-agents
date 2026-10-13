"use strict";

const { TransformStream } = require("node:stream/web");
const { resolveModel } = require("./providers/config");
const { sanitizeResult, safeError, runRequest } = require("./providers/safety");

function getProviderConfig(RED, id) {
  const node = RED.nodes.getNode(id);
  if (node?.type !== "model-provider" || typeof node.getProviderConfig !== "function") {
    throw Object.assign(new Error("Select a model-provider config node"), {
      code: "MISSING_PROVIDER_CONFIG",
    });
  }
  return node.getProviderConfig();
}

async function loadSDK() {
  return import("ai");
}

async function createProvider(RED, id, options = {}) {
  const config = getProviderConfig(RED, id);
  const sdk = await loadSDK();
  const transport = options.fetch || globalThis.fetch;
  // Redirects must not forward the credential to an unapproved destination.
  const fetch = (input, init) => transport(input, { ...init, redirect: "error" });
  const factory =
    config.provider === "openrouter"
      ? (await import("@openrouter/ai-sdk-provider")).createOpenRouter
      : (await import("@ai-sdk/gateway")).createGateway;
  const provider = factory({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    ...(config.provider === "openrouter" ? { decisionsBaseURL: config.decisionsBaseURL } : {}),
    fetch,
  });
  function safeModel(model, method) {
    const wrapped = Object.create(model);
    const warnings = (value) => sanitizeResult({ warnings: value || [] }, [config.apiKey]).warnings;
    // The SDK logs warnings before returning results; sanitize at the model seam.
    wrapped[method] = async (args) => {
      const result = await model[method](args);
      return {
        ...result,
        warnings: warnings(result.warnings),
      };
    };
    if (method === "doGenerate") {
      wrapped.doStream = async (args) => {
        const result = await model.doStream(args);
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                controller.enqueue(
                  chunk.type === "stream-start"
                    ? { ...chunk, warnings: warnings(chunk.warnings) }
                    : chunk,
                );
              },
            }),
          ),
        };
      };
    }
    return wrapped;
  }
  function createModel(operation, requested) {
    try {
      const selected = resolveModel(config, requested);
      if (operation === "language")
        return safeModel(provider.languageModel(selected), "doGenerate");
      if (operation === "embedding")
        return safeModel(
          config.provider === "openrouter"
            ? provider.textEmbeddingModel(selected)
            : provider.embeddingModel(selected),
          "doEmbed",
        );
      // ai@7.0.138 converts legacy v4 doEvaluate models in experimental_decide.
      if (operation === "decision")
        return safeModel(
          config.provider === "openrouter"
            ? provider.evaluationModel(selected)
            : provider.decisionModel(selected),
          config.provider === "openrouter" ? "doEvaluate" : "doDecide",
        );
      throw Object.assign(new Error("Invalid provider operation"), {
        code: "INVALID_PROVIDER_CONFIG",
      });
    } catch (error) {
      throw safeError(error);
    }
  }
  return Object.freeze({
    sdk,
    provider: config.provider,
    defaultModel: config.defaultModel,
    timeout: config.timeout,
    createLanguageModel: (requested) => createModel("language", requested),
    createEmbeddingModel: (requested) => createModel("embedding", requested),
    createDecisionModel: (requested) => createModel("decision", requested),
    run: (callback, { signal } = {}) =>
      runRequest((lifecycle) => callback({ sdk, ...lifecycle }), {
        timeout: config.timeout,
        signal:
          config.signal && signal
            ? AbortSignal.any([config.signal, signal])
            : config.signal || signal,
        secrets: [config.apiKey],
      }),
    sanitizeResult: (result) => sanitizeResult(result, [config.apiKey]),
    safeError,
  });
}

module.exports = { getProviderConfig, loadSDK, createProvider, sanitizeResult, safeError };
