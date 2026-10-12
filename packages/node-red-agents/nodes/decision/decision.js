"use strict";

const providers = require("../../shared/model-provider");
const { request } = require("./validation");

module.exports = function (RED) {
  function Decision(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const controllers = new Set();
    let closed = false;

    node.on("input", async (msg, send, done) => {
      const controller = new AbortController();
      const complete =
        done ||
        ((error) => {
          if (error) node.error(error, msg);
        });
      controllers.add(controller);
      try {
        if (closed) throw Object.assign(new Error("Request aborted"), { code: "REQUEST_ABORTED" });
        const input = request(config, msg);
        const adapter = await providers.createProvider(RED, config.provider);
        const model = adapter.createDecisionModel(input.model);
        const result = await adapter.run(
          ({ sdk, ...lifecycle }) =>
            sdk.experimental_decide({
              model,
              state: input.state,
              questions: input.questions,
              ...lifecycle,
            }),
          { signal: controller.signal },
        );
        if (closed) throw Object.assign(new Error("Request aborted"), { code: "REQUEST_ABORTED" });
        msg.decisionResult = result;
        (send || node.send.bind(node))(msg);
        complete();
      } catch (error) {
        complete(error.code === "INVALID_DECISION_INPUT" ? error : providers.safeError(error));
      } finally {
        controllers.delete(controller);
      }
    });

    node.on("close", (_removed, done) => {
      closed = true;
      for (const controller of controllers) controller.abort();
      if (done) done();
    });
  }
  RED.nodes.registerType("decision", Decision);
};
