"use strict";

const assert = require("node:assert/strict");
const { test, afterEach } = require("node:test");
const { once } = require("node:events");
const { createRequire } = require("node:module");
const helper = require("node-red-node-test-helper");
const providers = require("../../../shared/model-provider");
const register = require("../decision");
const provider = require("../../model-provider/model-provider");
const interaction = require("../../interaction/interaction");
const runtimeRequire = createRequire(require.resolve("node-red/package.json"));
const switchNode = runtimeRequire("@node-red/nodes/core/function/10-switch");
const catchNode = runtimeRequire("@node-red/nodes/core/common/25-catch");
const example = require("../examples/review-refund.json");

afterEach(() => helper.unload());

test(
  "importable example routes unchanged decisions across chosen threshold and resumes human review",
  { timeout: 10000 },
  async (t) => {
    const createProvider = providers.createProvider;
    let probability = 0.7;
    t.mock.method(providers, "createProvider", (RED, id) =>
      createProvider(RED, id, {
        fetch: async () =>
          new Response(
            JSON.stringify({ answers: { refund: { type: "noul", noul: probability } } }),
            {
              headers: { "content-type": "application/json" },
            },
          ),
      }),
    );
    const flow = example
      .filter((node) =>
        ["model-provider", "decision", "switch", "interaction", "catch"].includes(node.type),
      )
      .concat(
        [
          "decision-review-queue",
          "decision-review-continue",
          "decision-review-request",
          "decision-review-error",
        ].map((id) => ({ id, type: "helper" })),
      );
    await helper.load([register, provider, interaction, switchNode, catchNode], flow, {
      "decision-review-provider": { apiKey: "offline-example-key" },
    });
    const decision = helper.getNode("decision-review-jev");
    const human = helper.getNode("decision-review-human");
    const pending = once(helper.getNode("decision-review-request"), "input");
    decision.receive({ payload: "Refund ticket", decision: { state: "Refund ticket" } });
    const [request] = await pending;
    assert.equal(request.interaction.status, "pending");
    assert.equal(request.decisionResult.answers.refund.probability, 0.7);
    const continued = once(helper.getNode("decision-review-continue"), "input");
    human.receive({ interaction: { id: request.interaction.id, decision: "approve" } });
    const [resumed] = await continued;
    assert.equal(resumed.payload, "Refund ticket");
    assert.equal(resumed.interaction.decision, "approve");
    assert.equal(resumed.decisionResult.answers.refund.probability, 0.7);
    probability = 0.8;
    const queued = once(helper.getNode("decision-review-queue"), "input");
    decision.receive({ decision: { state: "Refund ticket" } });
    assert.equal((await queued)[0].decisionResult.answers.refund.probability, 0.8);
    const caught = once(helper.getNode("decision-review-error"), "input");
    decision.receive({ decision: { questions: {} } });
    assert.match((await caught)[0].error.message, /^Error: Invalid decision input/);
  },
);
