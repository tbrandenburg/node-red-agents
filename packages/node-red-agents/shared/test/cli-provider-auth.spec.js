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

test("sanitizes nested echoes and encoded keys without removing application field names", () => {
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
  assert.deepEqual(sanitize(value).env, { KEY: "[REDACTED]" });
});

test("default authentication preserves domain keys, probabilities and message histories", () => {
  const auth = resolveCLIAuth({}, { agent: "opencode-v1" }, {});
  const msg = {
    payload: { token: "word-label", secret: 0.2, headers: ["heading"] },
    probabilities: { password: 0.8, secret: 0.2 },
    messages: [{ role: "user", content: "hello", body: "task" }],
  };
  assert.deepEqual(auth.sanitize(msg), msg);
});

test("message cloning preserves cycles, shared references and deeply nested application data", () => {
  const sanitize = createSanitizer(["synthetic-cycle-secret"]);
  const msg = { payload: { token: "label", secret: "synthetic-cycle-secret" } };
  msg.self = msg;
  msg.alias = msg.payload;
  const copy = sanitize(msg);
  assert.notEqual(copy, msg);
  assert.equal(copy.self, copy);
  assert.equal(copy.alias, copy.payload);
  assert.equal(copy.payload.secret, "[REDACTED]");
  assert.equal(msg.payload.secret, "synthetic-cycle-secret");
  const deep = {};
  let tail = deep;
  for (let depth = 0; depth < 10000; depth++) tail = tail.next = {};
  tail.token = "label";
  let cloned = sanitize(deep);
  for (let depth = 0; depth < 10000; depth++) cloned = cloned.next;
  assert.equal(cloned.token, "label");
  assert.doesNotThrow(() => JSON.stringify(sanitize.diagnostic(msg)));
  let diagnostic = sanitize.diagnostic(deep);
  for (let depth = 0; depth < 21; depth++) diagnostic = diagnostic.next;
  assert.equal(diagnostic, "[REDACTED]");
  const sparse = new Array(3);
  sparse[0] = msg;
  const array = sanitize(sparse);
  assert.equal(array.length, 3);
  assert.equal(1 in array, false);
  assert.equal(array[0].self, array[0]);
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

test("logical text redaction bounds retained prefixes and preserves structured event metadata", () => {
  const secret = "synthetic-prefix-secret";
  const sanitize = createSanitizer([secret]);
  const events = [];
  const redactor = sanitize.events((event) => events.push(event));
  const push = (text, type = "text") =>
    redactor.push({
      type: "agent",
      sessionID: "session",
      data: { type, part: { id: "part", text } },
    });
  push("x".repeat(100000) + secret[0]);
  assert.equal(events[0].data.part.text, "x".repeat(100000));
  const progress = {
    type: "progress",
    data: { type: "step_finish", part: { tokens: { input: 2 } } },
  };
  redactor.push(progress);
  for (const char of secret.slice(1)) push(char, "reasoning");
  push(" suffix");
  redactor.flush();
  const text = events
    .filter((event) => event.type === "agent")
    .map((event) => event.data.part.text)
    .join("");
  assert.equal(text, "x".repeat(100000) + "[REDACTED] suffix");
  assert.deepEqual(
    events.find((event) => event.type === "progress"),
    progress,
  );
  assert.ok(
    events
      .filter((event) => event.type === "agent")
      .every((event) => event.sessionID === "session" && event.data.part.id === "part"),
  );
  const ordinary = [];
  const defaultRedactor = createSanitizer().events((event) => ordinary.push(event));
  defaultRedactor.push(progress);
  defaultRedactor.flush();
  assert.deepEqual(ordinary, [progress]);
});

test("transport filtering and Basic token redaction are diagnostic-only and preserve application outputs", () => {
  const credential = "synthetic-diagnostic-key";
  const encoded = Buffer.from("user:" + credential).toString("base64");
  const sanitize = createSanitizer([credential]);
  const app = { headers: ["heading"], authorization: "label", token: "word", secret: 0.2 };
  const diagnostic = sanitize.diagnostic({
    headers: { Authorization: "Basic " + encoded },
    authorization: "Basic " + encoded,
    cookie: "opaque-cookie",
    message: JSON.stringify({ headers: { Authorization: "bAsIc " + encoded } }),
    binary: Buffer.from("Basic " + encoded),
    output: app,
    payload: { headers: ["domain heading"], echo: credential },
  });
  assert.equal(diagnostic.headers, undefined);
  assert.equal(diagnostic.authorization, undefined);
  assert.equal(diagnostic.cookie, undefined);
  assert.ok(!diagnostic.message.includes(encoded));
  assert.equal(diagnostic.binary.toString(), "Basic [REDACTED]");
  assert.deepEqual(diagnostic.output, app);
  assert.deepEqual(diagnostic.payload, { headers: ["domain heading"], echo: "[REDACTED]" });
  assert.deepEqual(sanitize(app), app);
  assert.equal(sanitize("Basic " + encoded), "Basic " + encoded);
});
