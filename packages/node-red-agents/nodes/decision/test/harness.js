"use strict";

const { EventEmitter } = require("node:events");
const providers = require("../../../shared/model-provider");
const { validateConfig } = require("../../../shared/providers/config");
const register = require("../decision");

const key = "offline-decision-private-key";
const createProvider = providers.createProvider;
const questions = {
  refund: { type: "boolean", instructions: "Refund requested?" },
  team: {
    type: "choice",
    instructions: "Choose team",
    criteria: { billing: "Charges", other: null },
  },
  severity: { type: "score", instructions: "Severity?", criteria: ["Low", "Medium", "High"] },
};
const answers = {
  refund: { type: "boolean", probability: 0.8 },
  team: { type: "choice", choice: "billing", probabilities: { billing: 0.9, other: 0.1 } },
  severity: { type: "score", score: 1, probabilities: { 0: 0.33, 1: 0.33, 2: 0.33 } },
};

function harness(t, { provider = "gateway", timeout = 1000, fetch, config = {} } = {}) {
  const calls = [];
  const settings = validateConfig({
    provider,
    timeout,
    defaultModel: "typesafe-ai/jev",
    allowedModels: "typesafe/jev-1.13",
  });
  let Constructor;
  const RED = {
    nodes: {
      createNode(node) {
        Object.assign(node, new EventEmitter());
        node.on = EventEmitter.prototype.on;
        node.emit = EventEmitter.prototype.emit;
        node.send = () => {};
        node.error = () => {};
      },
      registerType(_name, constructor) {
        Constructor = constructor;
      },
      getNode: (id) =>
        id === "provider"
          ? {
              type: "model-provider",
              getProviderConfig: () => ({ ...settings, apiKey: key }),
            }
          : undefined,
    },
  };
  t.mock.method(providers, "createProvider", (red, id) =>
    createProvider(red, id, {
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (fetch) return fetch(url, init);
        return response({
          answers,
          rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
          usage: { inputTokens: 2, outputTokens: 3 },
          providerMetadata: { typesafe: { confidence: { team: 0.85 }, cost: 0.001, private: key } },
        });
      },
    }),
  );
  register(RED);
  const node = new Constructor({
    provider: "provider",
    state: '{"ticket":"Refund duplicate charge"}',
    questions: JSON.stringify(questions),
    model: "",
    ...config,
  });
  t.after(() => node.emit("close", false, () => {}));
  return { node, calls };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function invoke(node, msg = { payload: "original" }) {
  const sent = [];
  return new Promise((resolve) => {
    node.emit(
      "input",
      msg,
      (output) => sent.push(output),
      (error) => resolve({ msg, sent, error }),
    );
  });
}

module.exports = { harness, invoke, response, questions, answers, key };
