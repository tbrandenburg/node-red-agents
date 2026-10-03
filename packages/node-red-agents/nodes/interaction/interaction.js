"use strict";

const interaction = require("./lib/interaction");

// This bounds checkpoint acknowledgement, never the human wait itself.
function acknowledge(callback, record) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Interaction host acknowledgement timed out")),
      60000,
    );
    Promise.resolve()
      .then(() => callback(record))
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

module.exports = function (RED) {
  function InteractionNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.name = config.name || "";
    const pending = new Map();
    let closed = false;
    const host = RED.settings.nodeRedAgentsInteractionHost;

    function active() {
      if (closed) throw new Error("Interaction node is closed");
    }

    node.interaction = {
      version: 1,
      async plan(msg) {
        active();
        const plan = await interaction.plan(RED, node, config, msg);
        active();
        return plan;
      },
      resume(plan, original, value) {
        active();
        interaction.object(original, "Original message");
        const result = interaction.response(plan, value, node);
        const msg = RED.util.cloneMessage(original);
        msg.interaction = result;
        node.send(msg);
        return msg;
      },
    };

    node.on("input", async (msg, send, done) => {
      const finish =
        done ||
        ((err) => {
          if (err) node.error(err, msg);
        });
      try {
        active();
        const mode = interaction.mode(msg);
        if (host !== undefined && (host?.version !== 1 || typeof host.suspend !== "function")) {
          throw new Error("Interaction host requires version 1 and suspend(record)");
        }
        if (mode === "resolve") {
          const entry = pending.get(msg.interaction.id);
          if (!entry) throw new Error("Unknown or expired interaction id");
          interaction.response(entry.plan, msg.interaction, node);
          pending.delete(msg.interaction.id);
          node.interaction.resume(entry.plan, entry.original, msg.interaction);
          finish();
          return;
        }
        const original = RED.util.cloneMessage(msg);
        const plan = await node.interaction.plan(original);
        if (host !== undefined) {
          await acknowledge(host.suspend.bind(host), { version: 1, plan, msg: original });
          active();
          finish();
          return;
        }
        pending.set(plan.interactionId, { plan, original });
        const request = RED.util.cloneMessage(original);
        request.interaction = {
          id: plan.interactionId,
          status: "pending",
          prompt: plan.prompt,
          decisions: plan.decisions.map((choice) => ({ ...choice })),
        };
        (send || node.send.bind(node))([null, request]);
        finish();
      } catch (err) {
        finish(err);
      }
    });

    node.on("close", () => {
      closed = true;
      pending.clear();
    });
  }
  RED.nodes.registerType("interaction", InteractionNode);
};
