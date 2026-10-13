"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { harness, invoke, response, questions, answers, key } = require("./harness");

test("actual pinned SDK retains Boolean, Choice, Score, rounding and sanitized optional metadata", async (t) => {
  const { node, calls } = harness(t);
  const result = await invoke(node);
  assert.equal(result.error, undefined);
  assert.equal(result.sent[0], result.msg);
  assert.equal(result.msg.payload, "original");
  assert.deepEqual(result.msg.decisionResult.answers, answers);
  assert.deepEqual(result.msg.decisionResult.rounding, {
    probabilityDecimals: 2,
    scoreDecimals: 2,
  });
  assert.equal(result.msg.decisionResult.usage.totalTokens, 5);
  assert.equal(result.msg.decisionResult.providerMetadata.typesafe.confidence.team, 0.85);
  assert.equal(result.msg.decisionResult.providerMetadata.typesafe.cost, 0.001);
  assert.equal(JSON.stringify(result.msg).includes(key), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ai-gateway.vercel.sh/v4/ai/decision-model");
});

test("OpenRouter legacy evaluationModel works through decision runtime", async (t) => {
  const { node, calls } = harness(t, {
    provider: "openrouter",
    fetch: () =>
      response({
        answers: { ...answers, refund: { type: "noul", noul: 0.8 } },
        rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
      }),
  });
  const result = await invoke(node, {
    decision: { model: "typesafe/jev-1.13", state: ["one", "two"] },
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.msg.decisionResult.answers, answers);
  assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(result.msg.decisionResult.answers.team.confidence, undefined);
});

test("overrides use parsed JSON, allow complete Boolean criteria and preserve optional distributions", async (t) => {
  const minimal = {
    refund: answers.refund,
    team: { type: "choice", choice: "billing" },
    severity: { type: "score", score: 0.5 },
  };
  const { node, calls } = harness(t, {
    config: { state: "invalid", questions: "invalid" },
    fetch: () => response({ answers: minimal }),
  });
  const result = await invoke(node, {
    decision: {
      state: { customer: "request" },
      questions: {
        ...questions,
        refund: { ...questions.refund, criteria: { true: "Refund", false: "No refund" } },
      },
    },
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.msg.decisionResult.answers, minimal);
  assert.equal(result.msg.decisionResult.providerMetadata, undefined);
  assert.equal(JSON.parse(calls[0].init.body).stateParts[0].type, "json");
});

for (const [name, body] of Object.entries({
  missing: {},
  missingAnswer: { answers: { refund: answers.refund } },
  wrongType: { answers: { ...answers, refund: { type: "choice", choice: "billing" } } },
  invalidProbability: { answers: { ...answers, refund: { type: "boolean", probability: 2 } } },
  invalidChoice: { answers: { ...answers, team: { type: "choice", choice: "unknown" } } },
  invalidScore: { answers: { ...answers, severity: { type: "score", score: 9 } } },
  invalidDistribution: {
    answers: {
      ...answers,
      severity: { type: "score", score: 1, probabilities: { 0: 0.1, 1: 0.1, 2: 0.1 } },
    },
  },
})) {
  test(`malformed result ${name} reaches completion error without output`, async (t) => {
    const { node } = harness(t, { fetch: () => response(body) });
    const result = await invoke(node);
    assert.equal(result.error.code, "PROVIDER_ERROR");
    assert.deepEqual(result.sent, []);
    assert.equal(result.msg.decisionResult, undefined);
  });
}

for (const status of [401, 429, 404, 500]) {
  test(`HTTP ${status} becomes sanitized Catch-compatible error without retries`, async (t) => {
    const { node, calls } = harness(t, {
      fetch: () => response({ error: { message: key } }, status),
    });
    const result = await invoke(node);
    assert.equal(
      result.error.code,
      status === 401 ? "PROVIDER_AUTH" : status === 429 ? "PROVIDER_RATE_LIMIT" : "PROVIDER_ERROR",
    );
    assert.equal(result.error.statusCode, status);
    assert.equal(result.error.message.includes(key), false);
    assert.equal(result.error.cause, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(result.sent, []);
  });
}

test("disallowed model and missing provider fail before HTTP", async (t) => {
  const { node, calls } = harness(t);
  assert.equal(
    (await invoke(node, { decision: { model: "unsupported" } })).error.code,
    "INVALID_PROVIDER_CONFIG",
  );
  assert.equal(calls.length, 0);
});

test("missing provider is sanitized", async (t) => {
  const { node, calls } = harness(t, { config: { provider: "missing" } });
  assert.equal((await invoke(node)).error.code, "MISSING_PROVIDER_CONFIG");
  assert.equal(calls.length, 0);
});

test("network errors are sanitized", async (t) => {
  const { node } = harness(t, {
    fetch: () => {
      throw new Error(key);
    },
  });
  const result = await invoke(node);
  assert.equal(result.error.code, "PROVIDER_ERROR");
  assert.equal(result.error.message.includes(key), false);
});

test("timeout aborts the SDK transport", async (t) => {
  let signal;
  const { node } = harness(t, {
    timeout: 20,
    fetch: (_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    },
  });
  const result = await invoke(node);
  assert.equal(result.error.code, "REQUEST_TIMEOUT");
  assert.equal(signal.aborted, true);
  assert.deepEqual(result.sent, []);
});

test("close aborts independent concurrent controllers and prevents later sends", async (t) => {
  const signals = [];
  const { node } = harness(t, {
    fetch: (_url, init) => {
      signals.push(init.signal);
      if (signals.length === 2) node.emit("close", false, () => {});
      return new Promise(() => {});
    },
  });
  const results = await Promise.all([invoke(node), invoke(node)]);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
  for (const signal of signals) assert.equal(signal.aborted, true);
  for (const result of results) {
    assert.equal(result.error.code, "REQUEST_ABORTED");
    assert.deepEqual(result.sent, []);
  }
  assert.equal((await invoke(node)).error.code, "REQUEST_ABORTED");
});
