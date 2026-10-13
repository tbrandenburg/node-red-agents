"use strict";

const providers = require("../../shared/model-provider");
const { input, invalid } = require("./lib/input");
const { stream, languageModel } = require("./lib/stream");

module.exports = function (RED) {
  function ModelNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const active = new Set();
    let closed = false;
    node.on("input", async (msg, send, done) => {
      const controller = new AbortController();
      const emit = send || node.send.bind(node);
      active.add(controller);
      let timer;
      let timedout = false;
      try {
        const original = RED.util.cloneMessage(msg);
        if (closed) throw Object.assign(new Error("Closed"), { code: "REQUEST_ABORTED" });
        const request = await input(RED, node, config, original);
        // Trusted internal credential access is used only for cross-chunk redaction.
        const secret = config.streaming
          ? providers.getProviderConfig(RED, config.provider).apiKey
          : "";
        const adapter = await providers.createProvider(RED, config.provider);
        if (request.timeout)
          timer = setTimeout(() => {
            timedout = true;
            controller.abort();
          }, request.timeout);
        const result = await adapter.run(
          async ({ sdk, ...lifecycle }) => {
            if (request.operation === "embed") {
              return sdk.embed({
                model: adapter.createEmbeddingModel(request.model),
                value: request.value,
                ...lifecycle,
              });
            }
            const structured = request.operation === "structured";
            const options = {
              model: config.streaming
                ? languageModel(adapter, request.model)
                : adapter.createLanguageModel(request.model),
              ...request.prompt,
              ...lifecycle,
              ...(structured
                ? {
                    output: sdk.Output.object({
                      schema: sdk.jsonSchema(request.schema, {
                        validate: (value) =>
                          request.validate(value)
                            ? { success: true, value }
                            : {
                                success: false,
                                error: invalid("Model output does not match JSON schema"),
                              },
                      }),
                    }),
                  }
                : {}),
            };
            const raw = config.streaming
              ? await stream(adapter, options, structured, secret, (event) => {
                  if (closed || controller.signal.aborted || lifecycle.abortSignal.aborted) return;
                  emit([null, { ...RED.util.cloneMessage(original), modelEvent: event }]);
                })
              : await sdk.generateText(options);
            if (raw.finishReason === "error") throw new Error("Model generation failed");
            const object = structured ? (config.streaming ? raw.object : raw.output) : undefined;
            if (structured && !request.validate(object))
              throw invalid("Model output does not match JSON schema");
            return {
              text: raw.text,
              ...(structured ? { object } : {}),
              usage: raw.usage,
              totalUsage: raw.totalUsage,
              finishReason: raw.finishReason,
              warnings: raw.warnings,
              providerMetadata: raw.providerMetadata,
            };
          },
          { signal: controller.signal },
        );
        if (closed || controller.signal.aborted)
          throw Object.assign(new Error("Aborted"), { code: "REQUEST_ABORTED" });
        emit([{ ...RED.util.cloneMessage(original), modelResult: result }, null]);
        if (done) done();
      } catch (error) {
        const clean = timedout
          ? providers.safeError({ code: "REQUEST_TIMEOUT" })
          : error?.code === "INVALID_MODEL_INPUT"
            ? error
            : providers.safeError(error);
        if (done) done(clean);
        else node.error(clean, msg);
      } finally {
        controller.abort();
        clearTimeout(timer);
        active.delete(controller);
      }
    });
    node.on("close", (_removed, done) => {
      closed = true;
      for (const controller of active) controller.abort();
      done();
    });
  }
  RED.nodes.registerType("model", ModelNode);
};
