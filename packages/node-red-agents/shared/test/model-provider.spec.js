"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  createProvider,
  getProviderConfig,
  loadSDK,
  safeError,
  sanitizeResult,
} = require("../model-provider");
const { validateConfig } = require("../providers/config");
const { createHash } = require("node:crypto");

function environmentDigest() {
  return createHash("sha256")
    .update(JSON.stringify({ ...process.env }))
    .digest("hex");
}

const key = "offline-private-key/with+symbols";
function runtime(provider, overrides = {}, settings = {}) {
  const config = validateConfig(
    {
      provider,
      defaultModel: "typesafe/jev-1.13",
      allowedModels: "openai/gpt-test,openai/embed-test",
      ...overrides,
    },
    settings,
  );
  return {
    nodes: {
      getNode: (id) =>
        id === "config"
          ? { type: "model-provider", getProviderConfig: () => ({ ...config, apiKey: key }) }
          : undefined,
    },
  };
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-private": key },
  });
}
const questions = {
  bug: { type: "boolean", instructions: "Is this a bug?" },
  team: {
    type: "choice",
    instructions: "Choose team",
    criteria: { frontend: "UI", backend: "API" },
  },
  urgency: { type: "score", instructions: "Score urgency", criteria: ["Low", "High"] },
};
const answers = {
  bug: { type: "boolean", probability: 0.9 },
  team: { type: "choice", choice: "frontend", probabilities: { frontend: 0.9, backend: 0.1 } },
  urgency: { type: "score", score: 0.75, probabilities: { 0: 0.25, 1: 0.75 } },
};

test("published SDK decision names and mock model contract are present", async () => {
  const sdk = await loadSDK();
  assert.equal(typeof sdk.experimental_decide, "function");
  const mocks = await import("ai/test");
  assert.equal(typeof mocks.Experimental_DecisionMockModelV4, "function");
  const router = (await import("@openrouter/ai-sdk-provider")).createOpenRouter({ apiKey: key });
  assert.equal(router.decisionModel, undefined);
  assert.equal(typeof router.evaluationModel("typesafe/jev").doEvaluate, "function");
});

for (const provider of ["openrouter", "gateway"]) {
  test(`${provider} pinned decision model supports SDK experimental_decide and exact route`, async () => {
    const env = environmentDigest();
    const seen = [];
    const adapter = await createProvider(runtime(provider), "config", {
      fetch: async (url, init) => {
        seen.push({ url, init });
        return json(
          provider === "openrouter"
            ? {
                model: "typesafe/jev-1.13",
                answers: { ...answers, bug: { type: "noul", noul: 0.9 } },
                usage: { input_tokens: 2, output_tokens: 3, cost: 0.001 },
              }
            : {
                answers,
                usage: { inputTokens: 2, outputTokens: 3 },
                providerMetadata: { gateway: { authorization: key, note: key } },
                warnings: [{ type: "other", message: `Bearer ${key}` }],
              },
        );
      },
    });
    const model = adapter.createDecisionModel();
    assert.equal(model.specificationVersion, "v4");
    const result = await adapter.run(({ sdk, ...lifecycle }) =>
      sdk.experimental_decide({ model, state: { ticket: "Broken UI" }, questions, ...lifecycle }),
    );
    assert.equal(result.answers.bug.probability, 0.9);
    assert.equal(result.answers.team.choice, "frontend");
    assert.equal(result.answers.urgency.score, 0.75);
    assert.equal(seen.length, 1);
    assert.equal(
      seen[0].url,
      provider === "openrouter"
        ? "https://openrouter.ai/api/alpha/decisions"
        : "https://ai-gateway.vercel.sh/v4/ai/decision-model",
    );
    assert.equal(new Headers(seen[0].init.headers).get("authorization"), `Bearer ${key}`);
    assert.equal(seen[0].init.redirect, "error");
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.questions.bug.type, provider === "openrouter" ? "noul" : "boolean");
    assert.equal(JSON.stringify(result).includes(key), false);
    assert.equal(result.response.headers, undefined);
    assert.equal(result.response.body, undefined);
    assert.equal(environmentDigest(), env);
  });

  test(`${provider} language and embedding factory objects work through the actual SDK`, async () => {
    const seen = [];
    const adapter = await createProvider(runtime(provider), "config", {
      fetch: async (url, init) => {
        seen.push(url);
        if (url.endsWith("embeddings"))
          return json({
            object: "list",
            model: "openai/embed-test",
            data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
            usage: { prompt_tokens: 2, total_tokens: 2 },
          });
        if (url.endsWith("embedding-model"))
          return json({ embeddings: [[0.1, 0.2]], usage: { tokens: 2 } });
        if (url.endsWith("chat/completions"))
          return json({
            id: "offline",
            model: "openai/gpt-test",
            created: 1,
            choices: [
              { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          });
        assert.equal(JSON.parse(init.body).prompt[0].role, "user");
        return json({
          content: [{ type: "text", text: "hello" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 2 }, outputTokens: { total: 1 } },
          warnings: [],
        });
      },
    });
    const text = await adapter.run(({ sdk, ...lifecycle }) =>
      sdk.generateText({
        model: adapter.createLanguageModel("openai/gpt-test"),
        prompt: "Hi",
        ...lifecycle,
      }),
    );
    assert.equal(text.text, "hello");
    const embedded = await adapter.run(({ sdk, ...lifecycle }) =>
      sdk.embed({
        model: adapter.createEmbeddingModel("openai/embed-test"),
        value: "Hi",
        ...lifecycle,
      }),
    );
    assert.deepEqual(embedded.embedding, [0.1, 0.2]);
    assert.deepEqual(
      seen,
      provider === "openrouter"
        ? [
            "https://openrouter.ai/api/v1/chat/completions",
            "https://openrouter.ai/api/v1/embeddings",
          ]
        : [
            "https://ai-gateway.vercel.sh/v4/ai/language-model",
            "https://ai-gateway.vercel.sh/v4/ai/embedding-model",
          ],
    );
  });

  for (const status of [401, 429, 404, 500]) {
    test(`${provider} HTTP ${status} sanitized, with no automatic retries`, async () => {
      let calls = 0;
      const adapter = await createProvider(runtime(provider), "config", {
        fetch: async () => {
          calls++;
          return json({ error: { message: `Rejected ${key}`, code: status } }, status);
        },
      });
      await assert.rejects(
        adapter.run(({ sdk, ...lifecycle }) =>
          sdk.experimental_decide({
            model: adapter.createDecisionModel(),
            state: "Hi",
            questions,
            ...lifecycle,
          }),
        ),
        (error) => {
          assert.equal(error.statusCode, status);
          assert.equal(
            error.code,
            status === 401
              ? "PROVIDER_AUTH"
              : status === 429
                ? "PROVIDER_RATE_LIMIT"
                : "PROVIDER_ERROR",
          );
          assert.equal(error.cause, undefined);
          assert.equal(JSON.stringify(error).includes(key), false);
          assert.equal(error.message.includes(key), false);
          return true;
        },
      );
      assert.equal(calls, 1);
    });
  }

  test(`${provider} timeout and caller cancellation abort actual SDK fetch`, async () => {
    for (const timedout of [true, false]) {
      const controller = new AbortController();
      let received;
      const adapter = await createProvider(
        runtime(provider, { timeout: timedout ? 25 : 1000 }),
        "config",
        {
          fetch: (_url, init) => {
            received = init.abortSignal || init.signal;
            if (!timedout) controller.abort(new Error(key));
            return new Promise((_, reject) => {
              if (received.aborted) return reject(received.reason);
              received.addEventListener("abort", () => reject(received.reason), { once: true });
            });
          },
        },
      );
      await assert.rejects(
        adapter.run(
          ({ sdk, ...lifecycle }) =>
            sdk.experimental_decide({
              model: adapter.createDecisionModel(),
              state: "Hi",
              questions,
              ...lifecycle,
            }),
          { signal: controller.signal },
        ),
        { code: timedout ? "REQUEST_TIMEOUT" : "REQUEST_ABORTED" },
      );
      assert.equal(received.aborted, true);
    }
  });
}

test("custom OpenRouter decision route is explicit and never falls back to default", async () => {
  const custom = {
    baseURL: "https://proxy.example/router",
    decisionsBaseURL: "https://proxy.example/alpha",
  };
  const urls = [];
  const adapter = await createProvider(
    runtime("openrouter", custom, {
      nodeRedAgentsModelProvider: { allowedBaseURLs: Object.values(custom) },
    }),
    "config",
    {
      fetch: async (url) => {
        urls.push(url);
        return json({ answers: { ...answers, bug: { type: "noul", noul: 0.9 } } });
      },
    },
  );
  await adapter.run(({ sdk, ...lifecycle }) =>
    sdk.experimental_decide({
      model: adapter.createDecisionModel(),
      state: "Hi",
      questions,
      ...lifecycle,
    }),
  );
  assert.deepEqual(urls, ["https://proxy.example/alpha/decisions"]);
});

test("missing config, disallowed model and malformed provider response are safe failures", async () => {
  assert.throws(() => getProviderConfig(runtime("openrouter"), "missing"), {
    code: "MISSING_PROVIDER_CONFIG",
  });
  const adapter = await createProvider(runtime("openrouter", { timeout: 100 }), "config", {
    fetch: async () => json({ leaked: key }),
  });
  assert.throws(() => adapter.createLanguageModel("openai/not-allowed"), {
    code: "INVALID_PROVIDER_CONFIG",
  });
  await assert.rejects(
    adapter.run(({ sdk, ...lifecycle }) =>
      sdk.experimental_decide({
        model: adapter.createDecisionModel(),
        state: "Hi",
        questions,
        ...lifecycle,
      }),
    ),
    { code: "PROVIDER_ERROR" },
  );
  await assert.rejects(
    adapter.run(() => {
      throw new Error(`network ${key}`);
    }),
    { message: "Model provider request failed" },
  );
  const controller = new AbortController();
  controller.abort(key);
  await assert.rejects(
    adapter.run(() => assert.fail("Must not execute"), { signal: controller.signal }),
    { code: "REQUEST_ABORTED" },
  );
  await assert.rejects(
    adapter.run(() => new Promise(() => {})),
    { code: "REQUEST_TIMEOUT" },
  );
});

test("sanitizes nested result metadata, warning text, secret-bearing keys and cyclic values", () => {
  const result = sanitizeResult(
    {
      text: key,
      warnings: [{ type: "other", message: `Bearer unknown-token ${encodeURIComponent(key)}` }],
      providerMetadata: {
        auth: { apiKey: key, headers: { authorization: key }, safe: key, [key]: key },
        cost: 0.01,
      },
      response: { modelId: "known", body: key, headers: { token: key } },
      request: { body: key },
    },
    [key],
  );
  assert.equal(result.text, "[redacted]");
  assert.equal(result.providerMetadata.auth.apiKey, undefined);
  assert.equal(result.response.body, undefined);
  assert.equal(JSON.stringify(result).includes(key), false);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => sanitizeResult({ providerMetadata: cyclic }));
  assert.equal(safeError({ message: key, cause: { statusCode: 429 } }).code, "PROVIDER_RATE_LIMIT");
});

test("config-node close cancels adapters and prevents reuse after redeploy", async () => {
  const controller = new AbortController();
  const RED = runtime("openrouter");
  const getNode = RED.nodes.getNode;
  RED.nodes.getNode = (id) => {
    const node = getNode(id);
    return (
      node && {
        ...node,
        getProviderConfig: () => ({ ...node.getProviderConfig(), signal: controller.signal }),
      }
    );
  };
  const adapter = await createProvider(RED, "config");
  await assert.rejects(
    adapter.run(
      ({ abortSignal }) => {
        controller.abort();
        assert.equal(abortSignal.aborted, true);
        return new Promise(() => {});
      },
      { signal: new AbortController().signal },
    ),
    { code: "REQUEST_ABORTED" },
  );
  await assert.rejects(
    adapter.run(() => assert.fail("Closed config must not execute")),
    { code: "REQUEST_ABORTED" },
  );
});

test("structured generation and decision rounding survive safe result projection", () => {
  assert.deepEqual(
    sanitizeResult(
      {
        object: { value: key },
        output: { valid: true },
        rounding: { probabilityDecimals: 2 },
        unapproved: key,
      },
      [key],
    ),
    {
      object: { value: "[redacted]" },
      output: { valid: true },
      rounding: { probabilityDecimals: 2 },
    },
  );
});
