"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { start, leakFree } = require("./lib/model-live-instance");

const LIVE = process.env.E2E_MODEL_LIVE === "1";
const INVALID = "sk-or-v1-synthetic-invalid-live-e2e";
const TEXT = process.env.E2E_MODEL_TEXT || "openai/gpt-4.1-nano";
const EMBED = "openai/text-embedding-3-small";
const JEV = "typesafe/jev-1.13";
const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string", enum: ["pong"] } },
  required: ["answer"],
  additionalProperties: false,
};
const QUESTIONS = {
  refund: {
    type: "boolean",
    instructions: "Is a refund requested?",
    criteria: { true: "Refund requested", false: "No refund requested" },
  },
  team: {
    type: "choice",
    instructions: "Select responsible team",
    criteria: { billing: "Charges and refunds", support: "Technical support" },
  },
  severity: {
    type: "score",
    instructions: "How severe is the issue?",
    criteria: ["Cosmetic", "Workaround exists", "Blocking"],
  },
};

function flow(options = {}, provider = "openrouter") {
  const { payload = "Reply with exactly pong. No tools or explanation.", ...config } = options;
  const target = {
    id: "live-target",
    type: "model",
    z: "live-tab",
    provider: "live-provider",
    operation: "generate",
    input: "payload",
    inputType: "msg",
    timeout: 55000,
    wires: [["final"], ["event"]],
    ...config,
  };
  if (target.type === "decision") target.id = "live-decision";
  return [
    { id: "live-tab", type: "tab", label: "Disposable live provider E2E" },
    {
      id: "live-provider",
      type: "model-provider",
      provider,
      defaultModel: TEXT,
      allowedModels: `${TEXT},${EMBED},${provider === "gateway" ? "typesafe-ai/jev" : JEV}`,
      timeout: 55000,
    },
    {
      id: "live-inject",
      type: "inject",
      z: "live-tab",
      props: [{ p: "payload" }],
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
      payloadType: typeof payload === "string" ? "str" : "json",
      wires: [[target.id]],
    },
    target,
    { id: "live-catch", type: "catch", z: "live-tab", scope: [target.id], wires: [["error"]] },
    ...["final", "event", "error"].map((id) => ({
      id,
      type: "debug",
      z: "live-tab",
      active: true,
      tosidebar: true,
      complete: "true",
      targetType: "full",
      wires: [],
    })),
  ];
}

function success(messages, instance) {
  const error = messages.error[0]?.error;
  leakFree(error || {});
  const code = /^[A-Z_]+$/.test(error?.code) ? error.code : "UNKNOWN";
  assert.equal(
    messages.error.length,
    0,
    `live Catch: ${code}; message=${String(error?.message).slice(0, 500)}; network=${JSON.stringify(instance.network.slice(-4))}`,
  );
  assert.equal(messages.final.length, 1, "expected exactly one final output");
  return messages.final[0];
}

function failure(messages, code) {
  assert.equal(messages.final.length, 0, "failed request emitted success");
  assert.equal(messages.error.length, 1, "expected exactly one Catch output");
  assert.equal(messages.error[0].error.code, code);
  leakFree(messages);
}

test(
  "real shared model providers (#66 / #67–71)",
  {
    skip: LIVE ? false : "opt in with E2E_MODEL_LIVE=1; real provider requests incur billing",
    timeout: 590000,
  },
  async (t) => {
    assert.ok(Boolean(process.env.OPENROUTER_API_KEY), "OPENROUTER_API_KEY is required");
    const instance = await start();
    let current = instance;
    t.after(async () => {
      await current.stop();
      current.remove();
    });
    let authenticated = false;
    await t.test("OpenRouter generate: real auth, preserved payload, one final", async () => {
      await current.deploy(flow(), process.env.OPENROUTER_API_KEY);
      const result = success(await current.run(), current);
      assert.match(result.modelResult.text, /pong/i);
      assert.equal(result.payload, flow()[2].payload);
      assert.equal(current.network.filter((event) => event.phase === "start").length, 1);
      authenticated = true;
    });
    // Fail fast rather than billing subsequent cases after a broken auth/generation probe.
    assert.ok(
      authenticated,
      "OpenRouter auth/generate failed; remaining live scenarios not executed",
    );

    await t.test("malformed model and decision input fail before any network call", async () => {
      for (const [config, code] of [
        [{ payload: { not: "text" } }, "INVALID_MODEL_INPUT"],
        [{ operation: "structured", schema: "{" }, "INVALID_MODEL_INPUT"],
        [
          { type: "decision", state: "{}", questions: "{}", wires: [["final"]] },
          "INVALID_DECISION_INPUT",
        ],
      ]) {
        t.diagnostic(
          `pre-call validation: ${config.type || config.operation || "non-text prompt"}`,
        );
        const invalid = await start();
        try {
          await invalid.deploy(flow(config), INVALID);
          failure(await invalid.run(), code);
          assert.equal(invalid.network.length, 0, "invalid input made a provider call");
        } finally {
          await invalid.stop();
          invalid.remove();
        }
      }
    });
    await t.test("structured generation validates a real schema-bound object", async () => {
      await current.deploy(
        flow({
          operation: "structured",
          schema: JSON.stringify(SCHEMA),
          payload: 'Return JSON with answer equal to "pong".',
        }),
      );
      assert.deepEqual(success(await current.run(), current).modelResult.object, {
        answer: "pong",
      });
    });
    await t.test(
      "streaming emits text deltas and exactly one final (no duplicate event)",
      async () => {
        await current.deploy(flow({ streaming: true }));
        const messages = await current.run();
        const final = success(messages, current);
        assert.ok(messages.event.length > 0, "no stream events");
        assert.ok(messages.event.every((message) => message.modelEvent.type === "text-delta"));
        assert.equal(
          messages.event.map((message) => message.modelEvent.text).join(""),
          final.modelResult.text,
        );
      },
    );
    await t.test("embedding: real openai/text-embedding-3-small numeric vector", async () => {
      await current.deploy(flow({ operation: "embed", model: EMBED, payload: "small live test" }));
      const vector = success(await current.run(), current).modelResult.embedding;
      assert.ok(Array.isArray(vector) && vector.length > 0);
      assert.ok(vector.every((value) => typeof value === "number" && Number.isFinite(value)));
    });
    await t.test("Jev 1.13: Boolean, Choice and Score in one real request", async () => {
      await current.deploy(
        flow({
          type: "decision",
          model: JEV,
          state: JSON.stringify({ ticket: "I was charged twice. Please refund the duplicate." }),
          questions: JSON.stringify(QUESTIONS),
          wires: [["final"]],
        }),
      );
      const answers = success(await current.run(), current).decisionResult.answers;
      assert.equal(answers.refund.type, "boolean");
      assert.ok(answers.refund.probability >= 0 && answers.refund.probability <= 1);
      assert.equal(answers.team.type, "choice");
      assert.ok(["billing", "support"].includes(answers.team.choice));
      assert.equal(answers.severity.type, "score");
      assert.ok(answers.severity.score >= 0 && answers.severity.score <= 2);
    });
    await t.test("encrypted disk storage, export and real restart reload", async () => {
      await current.deploy(flow());
      const exported = await (await current.request("/flows")).json();
      leakFree(exported);
      assert.ok(exported.every((node) => !Object.hasOwn(node, "credentials")));
      const disk = fs.readFileSync(path.join(current.userDir, "flows.json"), "utf8");
      const credentials = fs.readFileSync(path.join(current.userDir, "flows_cred.json"), "utf8");
      leakFree(disk);
      leakFree(credentials);
      assert.equal(typeof JSON.parse(credentials).$, "string", "credentials not encrypted");
      const { userDir, secret } = current;
      await current.stop();
      current = await start({ userDir, secret });
      assert.match(success(await current.run(), current).modelResult.text, /pong/i);
      const imported = await start();
      try {
        await imported.deploy(exported);
        const before = imported.network.length;
        failure(await imported.run(), "MISSING_PROVIDER_CREDENTIAL");
        assert.equal(imported.network.length, before);
      } finally {
        await imported.stop();
        imported.remove();
      }
    });
    await t.test(
      "rotation to synthetic invalid key reaches Catch safely; restore live key",
      async () => {
        await current.deploy(flow(), INVALID);
        failure(await current.run(), "PROVIDER_AUTH");
        assert.ok(current.network.some((event) => [401, 403].includes(event.status)));
        await current.deploy(flow(), process.env.OPENROUTER_API_KEY);
        assert.match(success(await current.run(), current).modelResult.text, /pong/i);
      },
    );
    await t.test(
      "optional Gateway generate + Jev decisions",
      {
        skip: process.env.AI_GATEWAY_API_KEY
          ? false
          : "AI_GATEWAY_API_KEY absent; Gateway not verified",
      },
      async () => {
        await current.deploy(flow({}, "gateway"), process.env.AI_GATEWAY_API_KEY);
        assert.match(success(await current.run(), current).modelResult.text, /pong/i);
        await current.deploy(
          flow(
            {
              type: "decision",
              model: "typesafe-ai/jev",
              state: "{}",
              questions: JSON.stringify(QUESTIONS),
              wires: [["final"]],
            },
            "gateway",
          ),
        );
        assert.equal(
          Object.keys(success(await current.run(), current).decisionResult.answers).length,
          3,
        );
      },
    );
    await t.test(
      "real OpenCode default smoke then shared-provider auth in isolated profile",
      async (cliTest) => {
        assert.ok(
          (process.env.PATH || "")
            .split(path.delimiter)
            .some((directory) => fs.existsSync(path.join(directory, "opencode"))),
          "opencode unavailable; CLI live auth not verified",
        );
        // Each profile is isolated: default mode uses inherited CLI authentication,
        // provider mode receives only the native config-node credential.
        for (const mode of ["default", "provider"]) {
          const cli = await start({ cli: true, ambientCLI: mode === "default" });
          try {
            await cliTest.test(`authMode=${mode}`, async () => {
              execFileSync("ss", ["-H", "-ltn"], { timeout: 5000 });
              await cli.deploy(
                flow({
                  type: "agent",
                  agent: "opencode",
                  runtime: "direct",
                  invocation: "prompt",
                  prompt: "payload",
                  promptType: "msg",
                  authMode: mode === "provider" ? "provider" : undefined,
                  modelProvider: mode === "provider" ? "live-provider" : undefined,
                  openCodeVersionMode: "v1",
                  model: mode === "default" ? `openrouter/${TEXT}` : "",
                  modelType: "str",
                  timeout: 55,
                  timeoutType: "num",
                  cwd: cli.userDir,
                  cwdType: "str",
                  wires: [["final"], ["event"]],
                }),
                process.env.OPENROUTER_API_KEY,
              );
              const result = success(await cli.run(), cli);
              assert.match(String(result.payload), /pong/i);
              assert.equal(
                result.agentExecution.authMode,
                undefined,
                "auth configuration leaked into execution",
              );
            });
          } finally {
            await cli.stop();
            cli.remove();
          }
        }
      },
    );
    await t.test(
      "real agent-server shared auth, daemon restart and credential rotation",
      async () => {
        const server = await start({ cli: true });
        const serverFlow = flow({
          type: "agent-server",
          operation: "message",
          authMode: "provider",
          modelProvider: "live-provider",
          apiVersionMode: "v1",
          model: "",
          modelType: "str",
          promptProp: "payload",
          promptPropType: "msg",
          sessionIdProp: "sessionID",
          sessionIdPropType: "msg",
          hostname: "127.0.0.1",
          startupTimeoutMs: 20000,
          requestTimeoutMs: 50000,
          wires: [["final"], ["event"]],
        });
        try {
          await server.deploy(serverFlow, process.env.OPENROUTER_API_KEY);
          const first = success(await server.run(), server);
          assert.match(String(first.payload), /pong/i);
          assert.equal(typeof first.sessionID, "string");
          const terminated = success(
            await server.run([
              { p: "operation", v: "terminate", vt: "str" },
              { p: "sessionID", v: first.sessionID, vt: "str" },
            ]),
            server,
          );
          assert.equal(terminated.payload, true);
          await server.deploy(serverFlow, INVALID);
          const rejected = await server.run();
          assert.equal(rejected.final.length, 0, "invalid daemon credential emitted success");
          assert.equal(rejected.error.length, 1, "invalid daemon credential did not reach Catch");
          leakFree(rejected);
          await server.deploy(serverFlow, process.env.OPENROUTER_API_KEY);
          const restored = success(await server.run(), server);
          assert.match(String(restored.payload), /pong/i);
          assert.notEqual(restored.sessionID, first.sessionID);
        } finally {
          await server.stop();
          server.remove();
        }
      },
    );
  },
);
