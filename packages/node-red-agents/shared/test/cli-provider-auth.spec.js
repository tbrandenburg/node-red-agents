"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveCLIAuth, createSanitizer } = require("../cli-provider-auth");

function configuration(provider = "openrouter", overrides = {}) {
  const config = {
    provider,
    apiKey: "synthetic-provider-secret",
    defaultModel: "anthropic/claude-test",
    allowedModels: ["openai/test"],
    baseURL:
      provider === "openrouter"
        ? "https://openrouter.ai/api/v1"
        : "https://ai-gateway.vercel.sh/v4/ai",
    ...overrides,
  };
  return {
    nodes: { getNode: () => ({ type: "model-provider", getProviderConfig: () => config }) },
  };
}

test("absent auth config preserves CLI defaults, ignores provider reference and copies env", () => {
  const env = { PATH: "/bin", OPENROUTER_API_KEY: "synthetic-ambient-secret" };
  const auth = resolveCLIAuth(
    null,
    { agent: "copilot", modelProvider: "ignored", model: "existing" },
    env,
  );
  assert.deepEqual(auth.env, env);
  assert.notEqual(auth.env, env);
  assert.equal(auth.model, "existing");
  assert.equal(auth.cliProvider, undefined);
});

for (const [agent, provider, prefix, key] of [
  ["opencode", "openrouter", "openrouter", "OPENROUTER_API_KEY"],
  ["opencode-v1", "openrouter", "openrouter", "OPENROUTER_API_KEY"],
  ["opencode-v2", "openrouter", "openrouter", "OPENROUTER_API_KEY"],
  ["pi", "openrouter", "openrouter", "OPENROUTER_API_KEY"],
  ["opencode-v1", "gateway", "vercel", "AI_GATEWAY_API_KEY"],
  ["pi", "gateway", "vercel-ai-gateway", "AI_GATEWAY_API_KEY"],
]) {
  test(`${agent}/${provider} provider and environment mappings are explicit`, () => {
    const environment = { PATH: "/bin", [key]: "synthetic-ambient-secret" };
    const before = JSON.stringify({ ...process.env });
    const options = { agent, authMode: "provider", modelProvider: "provider" };
    const auth = resolveCLIAuth(configuration(provider), options, environment);
    assert.equal(auth.env[key], "synthetic-provider-secret");
    assert.equal(auth.model, `${prefix}/anthropic/claude-test`);
    assert.equal(auth.cliProvider, prefix);
    assert.equal(environment[key], "synthetic-ambient-secret");
    assert.ok(
      JSON.stringify({ ...process.env }) === before,
      "process environment must remain unchanged",
    );
    const ambient = resolveCLIAuth(
      null,
      { ...options, authMode: "environment", model: `${prefix}/openai/test` },
      environment,
    );
    assert.equal(ambient.env[key], environment[key]);
    assert.equal(ambient.model, `${prefix}/openai/test`);
    assert.throws(
      () =>
        resolveCLIAuth(null, { ...options, authMode: "environment", model: `${prefix}/test` }, {}),
      /credential is missing/,
    );
  });
}

test("rejects unsupported combinations, invalid modes, missing config and provider mismatch", () => {
  for (const agent of ["copilot", "other", "opencode-v2", "opencode"]) {
    assert.throws(
      () => resolveCLIAuth(configuration("gateway"), { authMode: "provider", agent }),
      /unsupported|Unsupported/,
    );
  }
  for (const model of ["", "openai/test", "vercel/test", "openrouter/"]) {
    assert.throws(() => resolveCLIAuth(null, { authMode: "environment", agent: "pi", model }, {}));
  }
  assert.throws(() => resolveCLIAuth(null, { authMode: "bogus" }), /Choose/);
  assert.throws(
    () => resolveCLIAuth({ nodes: { getNode: () => null } }, { authMode: "provider", agent: "pi" }),
    /config node/,
  );
  assert.throws(
    () =>
      resolveCLIAuth(configuration(), {
        authMode: "provider",
        agent: "pi",
        model: "anthropic/test",
      }),
    /must match/,
  );
  assert.throws(
    () =>
      resolveCLIAuth(configuration(), {
        authMode: "provider",
        agent: "pi",
        model: "openrouter/not-allowed",
      }),
    /allowed model/,
  );
  assert.throws(
    () =>
      resolveCLIAuth(configuration("openrouter", { baseURL: "https://proxy.example/v1" }), {
        authMode: "provider",
        agent: "pi",
      }),
    /Custom/,
  );
  const auth = resolveCLIAuth(
    configuration(),
    { authMode: "provider", agent: "pi", model: "openrouter/openai/test" },
    {},
  );
  assert.equal(auth.model, "openrouter/openai/test");
});

test("sanitizes nested echoes, error details, encoded keys and sensitive field names", () => {
  const secret = "synthetic key/with+punctuation";
  const sanitize = createSanitizer([secret]);
  const value = {
    text: `${secret} ${encodeURIComponent(secret)} ${Buffer.from(secret).toString("base64")} Bearer arbitrary-token`,
    nested: [{ [secret]: secret }],
    env: { KEY: secret },
    headers: { Authorization: secret },
  };
  const output = JSON.stringify(sanitize(value));
  for (const variant of [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
    "arbitrary-token",
  ]) {
    assert.ok(!output.includes(variant));
  }
  assert.equal(sanitize(value).env, "[REDACTED]");
});

test("sanitization preserves ordinary Node-RED Date and binary message properties", () => {
  const sanitize = createSanitizer(["synthetic-buffer-secret"]);
  const date = new Date(0);
  const bytes = Buffer.from([0, 255, 128]);
  const result = sanitize({ date, bytes, echo: Buffer.from("synthetic-buffer-secret") });
  assert.ok(result.date instanceof Date);
  assert.equal(result.date.getTime(), date.getTime());
  assert.ok(Buffer.isBuffer(result.bytes));
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.echo.toString(), "[REDACTED]");
});
