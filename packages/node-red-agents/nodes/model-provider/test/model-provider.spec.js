"use strict";

const assert = require("node:assert/strict");
const { test, afterEach } = require("node:test");
const helper = require("node-red-node-test-helper");
const register = require("../model-provider");
const { validateConfig, resolveModel } = require("../../../shared/providers/config");
const fs = require("node:fs");
const path = require("node:path");

afterEach(async () => {
  await helper.unload();
  helper.settings({});
});

async function load(apiKey, config = {}) {
  await helper.load(
    register,
    [{ id: "provider", type: "model-provider", provider: "openrouter", ...config }],
    { provider: { apiKey } },
  );
  return helper.getNode("provider");
}

test("native password credential registration and redeploy rotation", async () => {
  const node = await load("first-private-key");
  const signal = node.getProviderConfig().signal;
  assert.equal(signal.aborted, false);
  assert.equal(node.getProviderConfig().apiKey, "first-private-key");
  assert.equal(Object.keys(node).includes("getProviderConfig"), false);
  await helper.unload();
  assert.equal(signal.aborted, true);
  const rotated = await load("second-private-key");
  assert.equal(rotated.getProviderConfig().apiKey, "second-private-key");
  assert.equal(JSON.stringify(rotated.getProviderConfig()).includes("first-private-key"), false);
  const html = fs.readFileSync(path.join(__dirname, "..", "model-provider.html"), "utf8");
  assert.match(html, /credentials: \{ apiKey: \{ type: "password" \} \}/);
  assert.doesNotMatch(html.split("credentials:")[0], /apiKey/);
  assert.equal(
    require("../../../package.json")["node-red"].nodes["model-provider"],
    "nodes/model-provider/model-provider.js",
  );
});

test("missing credentials and invalid redeployed settings fail without leaking input", async () => {
  assert.throws((await load(undefined)).getProviderConfig, { code: "MISSING_PROVIDER_CREDENTIAL" });
  await helper.unload();
  const node = await load("hidden", { baseURL: "https://user:hidden@example.com" });
  assert.throws(
    node.getProviderConfig,
    (error) => error.code === "INVALID_PROVIDER_CONFIG" && !error.message.includes("hidden"),
  );
});

test("Node-RED exports encrypted credentials separately and restores them after reload", async () => {
  const secret = "offline-encryption-fixture";
  helper.settings({ get: (name) => (name === "credentialSecret" ? secret : undefined) });
  await load(undefined);
  helper._redNodes.addCredentials("provider", { apiKey: "offline-password-fixture" });
  const flow = helper._redNodes.getFlows().flows;
  assert.equal(JSON.stringify(flow).includes("offline-password-fixture"), false);
  assert.equal(flow[0].credentials, undefined);
  const encrypted = await helper._redNodes.exportCredentials();
  assert.equal(typeof encrypted.$, "string");
  assert.equal(JSON.stringify(encrypted).includes("offline-password-fixture"), false);
  await helper.unload();
  await helper.load(register, flow, encrypted);
  assert.equal(helper.getNode("provider").getProviderConfig().apiKey, "offline-password-fixture");
});

test("validates providers, timeout, models and trusted URLs including decisions derivation", () => {
  for (const config of [
    { provider: "other" },
    { timeout: 0 },
    { timeout: 1.2 },
    { timeout: 600001 },
    { baseURL: "http://example.com" },
    { baseURL: "https://example.com?key=secret" },
    { baseURL: "https://example.com" },
    { defaultModel: "bad model" },
    { allowedModels: [] },
  ]) {
    assert.throws(() => validateConfig({ provider: "openrouter", ...config }), {
      code: "INVALID_PROVIDER_CONFIG",
    });
  }
  const config = { provider: "openrouter", baseURL: "https://proxy.example/api/v1" };
  const settings = {
    nodeRedAgentsModelProvider: {
      allowedBaseURLs: [config.baseURL, "https://proxy.example/api/alpha"],
    },
  };
  assert.throws(() =>
    validateConfig(config, { nodeRedAgentsModelProvider: { allowedBaseURLs: [config.baseURL] } }),
  );
  assert.equal(
    validateConfig(config, settings).decisionsBaseURL,
    "https://proxy.example/api/alpha",
  );
  assert.throws(() =>
    validateConfig({ ...config, baseURL: "https://proxy.example/custom" }, settings),
  );
  const explicit = {
    provider: "openrouter",
    baseURL: "https://proxy.example/custom",
    decisionsBaseURL: "https://proxy.example/decide",
  };
  assert.equal(
    validateConfig(explicit, {
      nodeRedAgentsModelProvider: {
        allowedBaseURLs: [explicit.baseURL, explicit.decisionsBaseURL],
      },
    }).decisionsBaseURL,
    explicit.decisionsBaseURL,
  );
  assert.throws(() =>
    validateConfig({ provider: "gateway", decisionsBaseURL: explicit.decisionsBaseURL }, settings),
  );
  const models = validateConfig({
    provider: "gateway",
    defaultModel: "openai/default",
    allowedModels: "typesafe-ai/jev,\nopenai/other",
  });
  assert.equal(resolveModel(models), "openai/default");
  assert.equal(resolveModel(models, "typesafe-ai/jev"), "typesafe-ai/jev");
  assert.throws(() => resolveModel(models, "openai/untrusted"));
  assert.throws(() => resolveModel(models, false));
  assert.throws(() => validateConfig(null), { code: "INVALID_PROVIDER_CONFIG" });
  assert.throws(() => validateConfig({ provider: "gateway", defaultModel: false }));
  assert.throws(() => resolveModel(validateConfig({ provider: "gateway" })));
});
