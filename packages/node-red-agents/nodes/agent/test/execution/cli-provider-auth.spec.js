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
