"use strict";

const assert = require("node:assert/strict");
const { ReadableStream } = require("node:stream/web");
const { createRequire } = require("node:module");
const { test: nodeTest, before, after, afterEach } = require("node:test");
const test = (name, callback) => nodeTest(name, { timeout: 10000 }, callback);
const helper = require("node-red-node-test-helper");
const nodeRedRequire = createRequire(require.resolve("node-red/package.json"));
const catchNode = nodeRedRequire("@node-red/nodes/core/common/25-catch.js");
const providers = require("../../../shared/model-provider");
const { runRequest, sanitizeResult, safeError } = require("../../../shared/providers/safety");
const { resolveModel } = require("../../../shared/providers/config");
const register = require("../model");
const { deltas } = require("../lib/stream");
const original = { ...providers };
const secret = "offline-test-key-never-real";
const usage = { inputTokens: { total: 2 }, outputTokens: { total: 3 } };
const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
let sdk;
let mocks;

before(async () => {
  sdk = await import("ai");
  mocks = await import("ai/test");
  // The helper binds port 0: the OS reserves an available ephemeral port.
  await helper.startServer();
});
after(() => helper.stopServer());
afterEach(async () => {
  Object.assign(providers, original);
  await helper.unload();
});

function generated(text = "hello") {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  };
}

function adapter(language, embedding, options = {}) {
  const config = { defaultModel: options.defaultModel ?? "default", allowedModels: ["allowed"] };
  return {
    sdk,
    createLanguageModel: (id) => {
      resolveModel(config, id);
      return language;
    },
    createEmbeddingModel: (id) => {
      resolveModel(config, id);
      return embedding;
    },
    sanitizeResult: (value) => sanitizeResult(value, [secret]),
    safeError,
    run: (callback, { signal }) =>
      runRequest((lifecycle) => callback({ sdk, ...lifecycle }), {
        timeout: options.timeout || 1000,
        signal,
        secrets: [secret],
      }),
  };
}

async function load(
  config = {},
  selected = adapter(new mocks.MockLanguageModelV4({ doGenerate: generated() })),
) {
  providers.createProvider = async () => selected;
  providers.getProviderConfig = () => ({ apiKey: secret });
  await helper.load(
    [register, catchNode],
    [
      { id: "tab", type: "tab" },
      {
        id: "request",
        z: "tab",
        x: 100,
        y: 100,
        type: "model",
        provider: "provider",
        input: "payload",
        inputType: "msg",
        wires: [[], []],
        ...config,
      },
      {
        id: "error-observer",
        z: "tab",
        x: 100,
        y: 200,
        type: "catch",
        scope: ["request"],
        wires: [["caught"]],
      },
      { id: "caught", z: "tab", x: 200, y: 200, type: "helper" },
    ],
  );
  return helper.getNode("request");
}

async function ready(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "SDK invocation readiness timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function invoke(node, msg) {
  const outputs = [];
  const promise = new Promise((resolve) =>
    node._inputCallback(
      msg,
      (value) => outputs.push(value),
      (error) => resolve({ error, outputs }),
    ),
  );
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Input did not settle")), 3000);
      promise.finally(() => clearTimeout(timer));
    }),
  ]);
}

function streamed(parts, warnings = []) {
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
    warnings,
  };
}

function chunks(texts) {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "text" },
    ...texts.map((delta) => ({ type: "text-delta", id: "text", delta })),
    { type: "text-end", id: "text" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ];
}

test("generate invokes the real SDK, uses allowlisted override and preserves input fields", async () => {
  const model = new mocks.MockLanguageModelV4({ doGenerate: generated() });
  const node = await load({}, adapter(model));
  const msg = {
    _msgid: "trace",
    payload: "question",
    extra: { kept: true },
    model: "allowed",
    apiKey: "ignored",
    baseURL: "ignored",
    headers: { test: "ignored" },
  };
  const { error, outputs } = await invoke(node, msg);
  assert.equal(error, undefined);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0][1], null);
  assert.equal(outputs[0][0].modelResult.text, "hello");
  assert.deepEqual(outputs[0][0].extra, msg.extra);
  assert.equal(outputs[0][0].payload, "question");
  assert.equal(msg.modelResult, undefined);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(model.doGenerateCalls[0].prompt[0].content[0].text, "question");
  assert.equal(model.doGenerateCalls[0].headers?.test, undefined);
});

test("structured uses actual Output.object/jsonSchema and rejects schema-invalid model output", async () => {
  for (const [text, succeeds] of [
    ['{"answer":"yes"}', true],
    ['{"answer":3}', false],
    ["not json", false],
  ]) {
    const model = new mocks.MockLanguageModelV4({ doGenerate: generated(text) });
    const node = await load(
      { operation: "structured", schema: JSON.stringify(schema) },
      adapter(model),
    );
    const { error, outputs } = await invoke(node, { payload: "question" });
    assert.equal(!error, succeeds);
    assert.equal(outputs.length, succeeds ? 1 : 0);
    if (succeeds) assert.deepEqual(outputs[0][0].modelResult.object, { answer: "yes" });
    assert.equal(model.doGenerateCalls[0].responseFormat.type, "json");
    await helper.unload();
  }
});

test("embed calls the real SDK with a single text value and returns numeric vector", async () => {
  const model = new mocks.MockEmbeddingModelV4({
    doEmbed: { embeddings: [[0.1, 0.2]], usage: { tokens: 2 } },
  });
  const node = await load({ operation: "embed" }, adapter(undefined, model));
  const { error, outputs } = await invoke(node, { payload: "sample" });
  assert.equal(error, undefined);
  assert.deepEqual(outputs[0][0].modelResult.embedding, [0.1, 0.2]);
  assert.deepEqual(model.doEmbedCalls[0].values, ["sample"]);
});

test("typed messages and async JSONata input are evaluated by Node-RED", async () => {
  const model = new mocks.MockLanguageModelV4({ doGenerate: generated() });
  const node = await load(
    { inputMode: "messages", input: "history", inputType: "jsonata" },
    adapter(model),
  );
  const { error } = await invoke(node, {
    history: [{ role: "user", content: "question", providerOptions: { ignored: true } }],
  });
  assert.equal(error, undefined);
  assert.equal(model.doGenerateCalls[0].prompt[0].content[0].text, "question");
  assert.equal(model.doGenerateCalls[0].prompt[0].providerOptions, undefined);
});

for (const streaming of [false, true]) {
  test(`system/user/assistant history reaches actual SDK ${streaming ? "streamText" : "generateText"} in order`, async () => {
    const model = new mocks.MockLanguageModelV4({
      doGenerate: generated(),
      doStream: streamed(chunks(["hello"])),
    });
    const node = await load({ inputMode: "messages", streaming }, adapter(model));
    const history = [
      { role: "system", content: "Answer briefly" },
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "system", content: "Use plain text" },
      { role: "user", content: "Next question" },
    ];
    const { error, outputs } = await invoke(node, { payload: history });
    assert.equal(error, undefined);
    assert.equal(outputs.at(-1)[0].modelResult.text, "hello");
    const calls = streaming ? model.doStreamCalls : model.doGenerateCalls;
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].prompt.map(({ role, content }) => ({
        role,
        content: typeof content === "string" ? content : content[0].text,
      })),
      history,
    );
  });
}

test("invalid inputs, schema, model and unsupported embed streaming emit no success", async () => {
  const cases = [
    [{ operation: "unknown" }, { payload: "x" }],
    [{}, { payload: {} }],
    [{}, { payload: "x", model: 3 }],
    [{}, { payload: "x", model: "unapproved" }],
    [{ inputMode: "messages" }, { payload: [{ role: "tool", content: "x" }] }],
    [{ operation: "structured", schema: "{" }, { payload: "x" }],
    [
      { operation: "structured", schema: { type: "object", properties: { x: { type: "bad" } } } },
      { payload: "x" },
    ],
    [{ operation: "embed", streaming: true }, { payload: "x" }],
    [{ timeout: -1 }, { payload: "x" }],
  ];
  for (const [config, msg] of cases) {
    const node = await load(config);
    const { error, outputs } = await invoke(node, msg);
    assert.ok(error);
    assert.equal(outputs.length, 0);
    await helper.unload();
  }
  const node = await load({}, adapter(undefined, undefined, { defaultModel: "" }));
  assert.equal((await invoke(node, { payload: "x" })).error.code, "INVALID_PROVIDER_CONFIG");
});

test("stream consumes actual SDK fullStream, redacts split secrets, and emits exactly one final", async () => {
  const parts = chunks(["hello ", secret.slice(0, 9), secret.slice(9), " world"]);
  parts[0].warnings = [{ type: "other", message: secret }];
  const model = new mocks.MockLanguageModelV4({ doStream: streamed(parts) });
  const node = await load({ streaming: true }, adapter(model));
  const { error, outputs } = await invoke(node, { payload: "x", trace: 42 });
  assert.equal(error, undefined);
  const finals = outputs.filter(([final]) => final);
  const events = outputs.filter(([, event]) => event).map(([, event]) => event);
  assert.equal(finals.length, 1);
  assert.equal(finals[0][0].modelResult.text, "hello [redacted] world");
  assert.equal(events.map((event) => event.modelEvent.text).join(""), "hello [redacted] world");
  assert.ok(events.every((event) => event.trace === 42));
  assert.ok(!JSON.stringify(outputs).includes(secret));
});

test("streamed structured output validates and projects object using actual SDK", async () => {
  const model = new mocks.MockLanguageModelV4({
    doStream: streamed(chunks(['{"answer":', '"yes"}'])),
  });
  const node = await load({ streaming: true, operation: "structured", schema }, adapter(model));
  const { error, outputs } = await invoke(node, { payload: "x" });
  assert.equal(error, undefined);
  assert.deepEqual(outputs.at(-1)[0].modelResult.object, { answer: "yes" });
});

test("midstream error is consumed through completion, sanitized and never emits final", async () => {
  let consumed = 0;
  const parts = chunks(["partial output longer than the retained suffix to emit text"]);
  parts.splice(3, 0, {
    type: "error",
    error: Object.assign(new Error(secret), { statusCode: 429 }),
  });
  const model = new mocks.MockLanguageModelV4({
    doStream: {
      warnings: [],
      stream: new ReadableStream({
        pull(controller) {
          if (consumed === parts.length) return controller.close();
          controller.enqueue(parts[consumed++]);
        },
      }),
    },
  });
  const node = await load({ streaming: true }, adapter(model));
  const { error, outputs } = await invoke(node, { payload: "x" });
  assert.equal(error.code, "PROVIDER_RATE_LIMIT");
  assert.equal(consumed, parts.length);
  assert.ok(outputs.every(([final]) => final === null));
  assert.ok(!JSON.stringify(error).includes(secret));
});

test("provider creation, auth, network and unsupported model failures go to Catch without retries", async () => {
  for (const statusCode of [401, 404, 500, undefined]) {
    const model = new mocks.MockLanguageModelV4({
      doGenerate: async () => {
        throw Object.assign(new Error(secret), { statusCode });
      },
    });
    const node = await load({}, adapter(model));
    const { error, outputs } = await invoke(node, { payload: "x" });
    assert.ok(error);
    assert.equal(outputs.length, 0);
    assert.equal(model.doGenerateCalls.length, 1);
    assert.ok(!error.message.includes(secret));
    await helper.unload();
  }
  const node = await load();
  providers.createProvider = async () => {
    throw Object.assign(new Error(secret), { code: "MISSING_PROVIDER_CREDENTIAL" });
  };
  assert.equal((await invoke(node, { payload: "x" })).error.code, "MISSING_PROVIDER_CREDENTIAL");
});

test("provider is resolved per input and concurrent requests retain independent results", async () => {
  const releases = [];
  const model = new mocks.MockLanguageModelV4({
    doGenerate: (options) =>
      new Promise((resolve) => {
        releases.push(() => resolve(generated(options.prompt[0].content[0].text)));
      }),
  });
  const node = await load({}, adapter(model));
  let resolutions = 0;
  providers.createProvider = async () => {
    resolutions++;
    return adapter(model);
  };
  const first = invoke(node, { payload: "first", trace: 1 });
  const second = invoke(node, { payload: "second", trace: 2 });
  await ready(() => releases.length === 2);
  releases[1]();
  releases[0]();
  const results = await Promise.all([first, second]);
  assert.equal(resolutions, 2);
  assert.deepEqual(
    results.map(({ outputs }) => [outputs[0][0].trace, outputs[0][0].modelResult.text]),
    [
      [1, "first"],
      [2, "second"],
    ],
  );
});

test("provider error finish reason cannot become a successful generation result", async () => {
  const response = { ...generated("partial"), finishReason: { unified: "error", raw: "error" } };
  const model = new mocks.MockLanguageModelV4({ doGenerate: response });
  const node = await load({}, adapter(model));
  const { error, outputs } = await invoke(node, { payload: "x" });
  assert.equal(error.code, "PROVIDER_ERROR");
  assert.equal(outputs.length, 0);
});

test("native Node-RED done(error) reaches scoped Catch with original message", async () => {
  const node = await load({ operation: "structured", schema: "invalid" });
  const caught = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Catch did not receive error")), 2000);
    helper.getNode("caught").once("input", (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
  node.receive({ payload: "x", trace: "preserved" });
  const msg = await caught;
  assert.equal(msg.trace, "preserved");
  assert.equal(msg.error.source.id, "request");
  assert.match(msg.error.message, /Invalid structured JSON schema/);
  assert.equal(msg.modelResult, undefined);
});

test("node timeout and provider timeout abort SDK lifecycle and settle without success", async () => {
  for (const [config, timeout] of [
    [{ timeout: 10 }, 1000],
    [{}, 10],
  ]) {
    let signal;
    const model = new mocks.MockLanguageModelV4({
      doGenerate: (options) => {
        signal = options.abortSignal;
        return new Promise(() => {});
      },
    });
    const node = await load(config, adapter(model, undefined, { timeout }));
    const { error, outputs } = await invoke(node, { payload: "x" });
    assert.equal(error.code, "REQUEST_TIMEOUT");
    assert.ok(signal.aborted);
    assert.equal(outputs.length, 0);
    await helper.unload();
  }
});

test("close aborts concurrent active streams and prevents late final or event emissions", async () => {
  const signals = [];
  const model = new mocks.MockLanguageModelV4({
    doStream: (options) => {
      signals.push(options.abortSignal);
      return {
        warnings: [],
        stream: new ReadableStream({
          start(controller) {
            options.abortSignal.addEventListener(
              "abort",
              () => controller.error(options.abortSignal.reason),
              { once: true },
            );
          },
        }),
      };
    },
  });
  const node = await load({ streaming: true }, adapter(model));
  const first = invoke(node, { payload: "one" });
  const second = invoke(node, { payload: "two" });
  await ready(() => signals.length === 2);
  await helper.unload();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.error.code, "REQUEST_ABORTED");
    assert.equal(result.outputs.length, 0);
  }
  assert.ok(signals.every((signal) => signal.aborted));
});

test("redaction protects every split position of credentials, encoded credentials and Bearer tokens", () => {
  const selected = adapter();
  for (const value of [
    secret,
    encodeURIComponent("key/with space"),
    "Bearer token-with-any-length",
  ]) {
    const credential = value.startsWith("key") ? "key/with space" : secret;
    const safe = { sanitizeResult: (result) => sanitizeResult(result, [credential]) };
    for (let split = 0; split <= value.length; split++) {
      const events = [];
      const write = deltas(safe, credential, (event) => events.push(event.text));
      write("prefix " + value.slice(0, split));
      write(value.slice(split) + " suffix long enough to flush retained tail");
      write("", true);
      assert.equal(
        events.join(""),
        selected
          .sanitizeResult({
            text: "prefix " + value + " suffix long enough to flush retained tail",
          })
          .text.replace(encodeURIComponent("key/with space"), "[redacted]"),
      );
    }
  }
});
