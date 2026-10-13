"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runAgent } = require("../../lib/execution/lifecycle");
const { DirectRuntime } = require("../../lib/runtimes/direct");
const { SrtRuntime } = require("../../lib/runtimes/srt");
const { OpenCodeAdapter } = require("../../lib/agents/opencode");
const { PiAdapter } = require("../../lib/agents/pi");
const { resolveCLIAuth } = require("../../../../shared/cli-provider-auth");

const key = "synthetic-child-echo-secret";
const RED = {
  nodes: {
    getNode: () => ({
      type: "model-provider",
      getProviderConfig: () => ({
        provider: "openrouter",
        apiKey: key,
        baseURL: "https://openrouter.ai/api/v1",
        defaultModel: "anthropic/test",
        allowedModels: [],
      }),
    }),
  },
};

for (const runtime of [
  new DirectRuntime(),
  new SrtRuntime({
    binary: process.execPath,
    extraArgs: [
      "-e",
      "const {spawn}=require('child_process'); const c=spawn(process.argv[1],process.argv.slice(2),{stdio:'inherit',env:process.env}); c.on('exit',code=>{process.exitCode=code;});",
    ],
  }),
]) {
  test(`${runtime.constructor.name} propagates env and redacts malicious child output/stderr`, async () => {
    const adapter = new OpenCodeAdapter({ fixedVersion: 1 });
    adapter.buildExecution = (resolved) => ({
      command: process.execPath,
      args: [
        "-e",
        `
      const key = process.env.OPENROUTER_API_KEY;
      if (key !== '${key}') throw new Error('missing injected key');
      console.log(JSON.stringify({type:'text',sessionID:'test-session',part:{text:key}}));
      console.log(JSON.stringify({type:'error',error:{data:{message:key,headers:{Authorization:key}}}}));
      process.stderr.write(key.slice(0, 10));
      setImmediate(()=>process.stderr.write(key.slice(10)));
    `,
      ],
      env: { AUTH_TEST_MODEL: resolved.model },
    });
    const events = [];
    const statuses = [];
    const before = JSON.stringify({ ...process.env });
    const result = await runAgent({
      adapter,
      runtime,
      resolved: { invocation: "prompt", prompt: "hello" },
      executionId: runtime.constructor.name,
      onEvent: (event) => events.push(event),
      onStatus: (status) => statuses.push(status),
      resolveAuth: () =>
        resolveCLIAuth(
          RED,
          { agent: "opencode-v1", authMode: "provider" },
          { PATH: process.env.PATH },
        ),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.payload, "[REDACTED]");
    assert.ok(!JSON.stringify({ events, result }).includes(key));
    assert.ok(result.errorMessage.includes("[REDACTED]"));
    assert.deepEqual(statuses, ["running", "failed"]);
    assert.ok(JSON.stringify({ ...process.env }) === before);
  });
}

test("Pi provider selection uses --provider and the complete upstream model ID", () => {
  const auth = resolveCLIAuth(RED, { agent: "pi", authMode: "provider" }, {});
  const built = new PiAdapter().buildExecution({
    invocation: "prompt",
    prompt: "hello",
    model: auth.model,
    cliProvider: auth.cliProvider,
  });
  assert.equal(built.args[built.args.indexOf("--provider") + 1], "openrouter");
  assert.equal(built.args[built.args.indexOf("--model") + 1], "anthropic/test");
  assert.ok(!built.args.includes(key));
});

test("launch errors are redacted and unsupported combinations never reach runtime", async () => {
  const adapter = new OpenCodeAdapter({ fixedVersion: 1 });
  await assert.rejects(
    runAgent({
      adapter,
      runtime: {
        execute: () => {
          throw new Error(key);
        },
      },
      resolved: { invocation: "prompt", prompt: "hello" },
      executionId: "failure",
      resolveAuth: () => resolveCLIAuth(RED, { agent: "opencode-v1", authMode: "provider" }, {}),
    }),
    (error) => error.message === "[REDACTED]" && !error.cause,
  );
  await assert.rejects(
    runAgent({
      adapter,
      runtime: { execute: () => assert.fail("must not launch") },
      resolved: {},
      resolveAuth: () => resolveCLIAuth(RED, { agent: "copilot", authMode: "provider" }, {}),
    }),
    /unsupported/,
  );
});

test("real OpenCode parsed text fragments cannot reconstruct credentials in events or final retention", async () => {
  const credential = 'synthetic-split/key"with\\symbols';
  const configuration = {
    nodes: {
      getNode: () => ({
        ...RED.nodes.getNode(),
        getProviderConfig: () => ({
          ...RED.nodes.getNode().getProviderConfig(),
          apiKey: credential,
        }),
      }),
    },
  };
  for (const value of [
    credential,
    encodeURIComponent(credential),
    Buffer.from(credential).toString("base64"),
    JSON.stringify(credential).slice(1, -1),
  ]) {
    for (let split = 1; split < value.length; split++) {
      const events = [];
      const adapter = new OpenCodeAdapter({ fixedVersion: 1 });
      const result = await runAgent({
        adapter,
        runtime: {
          execute: async (_request, { onLine }) => {
            for (const text of [
              "prefix " + value.slice(0, split),
              value.slice(split) + " suffix",
            ]) {
              onLine(
                JSON.stringify({
                  type: "text",
                  sessionID: "offline-session",
                  part: { id: "text-part", text },
                }),
              );
            }
            onLine(
              JSON.stringify({
                type: "step_finish",
                sessionID: "offline-session",
                part: { cost: 0.01, tokens: { input: 2, output: 3 } },
              }),
            );
            return { exitCode: 0, signal: null, stderr: "", timedOut: false };
          },
        },
        resolved: { invocation: "prompt", prompt: "hello" },
        executionId: "split-test",
        onEvent: (event) => events.push(event),
        resolveAuth: () =>
          resolveCLIAuth(configuration, { agent: "opencode-v1", authMode: "provider" }, {}),
      });
      const text = (records) =>
        records
          .filter((event) => event.data.type === "text")
          .map((event) => event.data.part.text)
          .join("");
      assert.equal(text(events), "prefix [REDACTED] suffix");
      assert.equal(text(result.events), text(events));
      assert.equal(result.status, "completed");
      assert.equal(result.costUsd, 0.01);
      assert.ok(events.every((event) => event.sessionID === "offline-session"));
      assert.ok(!JSON.stringify({ events, result }).includes(value));
    }
  }
});

test("buffered safe suffix does not change original OpenCode result text boundaries", async () => {
  const result = await runAgent({
    adapter: new OpenCodeAdapter({ fixedVersion: 1 }),
    runtime: {
      execute: async (_request, { onLine }) => {
        onLine(JSON.stringify({ type: "text", part: { text: "hello after 2 attempts" } }));
        return { exitCode: 0, signal: null, stderr: "", timedOut: false };
      },
    },
    resolved: { invocation: "prompt", prompt: "hello" },
    executionId: "suffix-boundary",
    resolveAuth: () => resolveCLIAuth(RED, { agent: "opencode-v1", authMode: "provider" }, {}),
  });
  assert.equal(result.payload, "hello after 2 attempts");
  assert.equal(result.events.map((event) => event.data.part.text).join(""), result.payload);
});

test("Basic-auth diagnostic headers and text are removed before events and final errorDetail", async () => {
  const basic = "Basic " + Buffer.from("user:" + key).toString("base64");
  const events = [];
  const result = await runAgent({
    adapter: new OpenCodeAdapter({ fixedVersion: 1 }),
    runtime: {
      execute: async (_request, { onLine }) => {
        onLine(
          JSON.stringify({
            type: "error",
            error: {
              data: {
                message: "rejected " + basic,
                headers: {
                  Authorization: basic,
                  "Proxy-Authorization": basic,
                  Cookie: "private-cookie",
                },
                note: JSON.stringify({ headers: { Authorization: basic } }),
              },
            },
          }),
        );
        return { exitCode: 1, signal: null, stderr: "transport " + basic, timedOut: false };
      },
    },
    resolved: { invocation: "prompt", prompt: "hello" },
    executionId: "basic-diagnostic",
    onEvent: (event) => events.push(event),
    resolveAuth: () => resolveCLIAuth(RED, { agent: "opencode-v1", authMode: "provider" }, {}),
  });
  assert.equal(result.status, "failed");
  assert.equal(events[0].data.error.data.headers, undefined);
  assert.equal(result.errorDetail.data.headers, undefined);
  assert.equal(result.errorDetail.data.message, "rejected Basic [REDACTED]");
  assert.ok(!JSON.stringify({ events, result }).includes(basic));
  assert.ok(!result.errorMessage.includes(basic));
  const auth = resolveCLIAuth(RED, { agent: "opencode-v1", authMode: "provider" }, {});
  const application = {
    headers: ["heading"],
    payload: { headers: { label: "title" }, token: "word", secret: 0.2 },
  };
  assert.deepEqual(auth.sanitize(application), application);
  assert.equal(auth.safeError(new Error("launch " + basic)).message, "launch Basic [REDACTED]");
});
