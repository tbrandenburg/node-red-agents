"use strict";

const { validateConfig } = require("../../shared/providers/config");

module.exports = function (RED) {
  function ModelProvider(config) {
    RED.nodes.createNode(this, config);
    const lifecycle = new AbortController();
    this.on("close", () => lifecycle.abort());
    try {
      const settings = validateConfig(config, RED.settings);
      Object.defineProperty(this, "getProviderConfig", {
        value: () => {
          const apiKey = this.credentials?.apiKey;
          if (typeof apiKey !== "string" || !apiKey.trim()) {
            const error = new Error(
              "Model provider API key is missing; provision its password credential",
            );
            error.code = "MISSING_PROVIDER_CREDENTIAL";
            throw error;
          }
          return { ...settings, apiKey, signal: lifecycle.signal };
        },
      });
    } catch (error) {
      this.error(error.message);
      Object.defineProperty(this, "getProviderConfig", {
        value: () => {
          throw error;
        },
      });
    }
  }
  RED.nodes.registerType("model-provider", ModelProvider, {
    credentials: { apiKey: { type: "password" } },
  });
};
