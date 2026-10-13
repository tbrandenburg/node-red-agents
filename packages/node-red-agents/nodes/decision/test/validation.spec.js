"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const providers = require("../../../shared/model-provider");
const { harness, invoke, questions } = require("./harness");

const cyclic = {};
cyclic.self = cyclic;
const sparse = ["Low", "Medium", "High"];
delete sparse[1];
const invalid = {
  nullOverride: null,
  arrayOverride: [],
  apiKey: { apiKey: "private" },
  baseURL: { baseURL: "https://example.com" },
  sdkOptions: { providerOptions: {} },
  undefinedState: { state: undefined },
  nullState: { state: null },
  nonfiniteState: { state: { value: Infinity } },
  classState: { state: new Date() },
  cyclicState: { state: cyclic },
  undefinedModel: { model: 22 },
  noQuestions: { questions: {} },
  nullQuestions: { questions: null },
  blankName: { questions: { " ": questions.refund } },
  unknownType: { questions: { q: { type: "text", instructions: "Ask" } } },
  arrayType: { questions: { q: { type: ["boolean"], instructions: "Ask" } } },
  noInstructions: { questions: { q: { type: "boolean" } } },
  badInstructions: { questions: { q: { type: "boolean", instructions: false } } },
  unknownQuestionOption: { questions: { q: { ...questions.refund, headers: {} } } },
  partialBoolean: { questions: { q: { ...questions.refund, criteria: { true: "Yes" } } } },
  extraBoolean: {
    questions: {
      q: { ...questions.refund, criteria: { true: "Yes", false: "No", other: "Other" } },
    },
  },
  nullBooleanDescription: {
    questions: { q: { ...questions.refund, criteria: { true: null, false: "No" } } },
  },
  noChoiceLabels: { questions: { q: { ...questions.team, criteria: {} } } },
  blankChoiceLabel: { questions: { q: { ...questions.team, criteria: { "": "Empty" } } } },
  badChoiceDescription: { questions: { q: { ...questions.team, criteria: { a: true } } } },
  shortScore: { questions: { q: { ...questions.severity, criteria: ["Only"] } } },
  nullScore: { questions: { q: { ...questions.severity, criteria: ["Low", null] } } },
  unorderedScore: {
    questions: { q: { ...questions.severity, criteria: { low: "Low", high: "High" } } },
  },
  sparseScore: { questions: { q: { ...questions.severity, criteria: sparse } } },
};

for (const [name, decision] of Object.entries(invalid)) {
  test(`rejects ${name} before provider creation or billing`, async (t) => {
    const { node, calls } = harness(t);
    const result = await invoke(node, { decision });
    assert.equal(result.error.code, "INVALID_DECISION_INPUT");
    assert.equal(calls.length, 0);
    assert.equal(providers.createProvider.mock.callCount(), 0);
    assert.deepEqual(result.sent, []);
    assert.equal(result.error.message.includes("private"), false);
  });
}

for (const config of [{ state: "bad JSON" }, { questions: "bad JSON" }, { questions: "[]" }]) {
  test(`malformed editor JSON ${JSON.stringify(config)} fails before HTTP`, async (t) => {
    const { node, calls } = harness(t, { config });
    assert.equal((await invoke(node)).error.code, "INVALID_DECISION_INPUT");
    assert.equal(calls.length, 0);
  });
}
