"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { OpenCodeAdapter } = require("../../lib/agents/opencode");
const { PiAdapter } = require("../../lib/agents/pi");
const { CopilotAdapter } = require("../../lib/agents/copilot");
const { runAgent } = require("../../lib/execution/lifecycle");
const { DirectRuntime } = require("../../lib/runtimes/direct");
const { SrtRuntime } = require("../../lib/runtimes/srt");
const { resolveCLIAuth } = require("../../../../shared/cli-provider-auth");

const prompt = { invocation: "prompt", prompt: "S1 isolation check" };

test("v2 owns private servers for plain, guarded resume and ephemeral-config runs", () => {
  const adapter = new OpenCodeAdapter({ fixedVersion: 2 });
  for (const options of [
    {},
    { sessionID: "ses_existing" },
    { mcpServers: [{ name: "test", type: "remote", url: "https://example.invalid" }] },
    { allowedTools: ["read"] },
  ]) {
    const built = adapter.buildExecution({ ...prompt, ...options });
    assert.equal(built.command, options.sessionID ? "sh" : "opencode");
    assert.equal(built.args.filter((arg) => arg === "--standalone").length, 1);
    assert.ok(!built.args.includes("--server"));
    assert.equal(built.cwd, process.cwd());
    assert.equal(built.env.PWD, process.cwd());
    assert.deepEqual(built.cancellation, { signal: "SIGINT", graceMs: 5000 });
  }
});

for (const [label, cwd, expected, mode] of [
  ["absolute", os.tmpdir(), os.tmpdir(), "provider"],
  ["relative", ".", process.cwd(), "environment"],
  ["blank", "", process.cwd(), "provider"],
  ["unset", undefined, process.cwd(), "environment"],
]) {
  test(`v2 ${label} cwd reaches a real child with matching PWD and per-run auth`, async () => {
    const credential = `synthetic-s1-${label}-credential`;
    const environment = { PATH: process.env.PATH, PWD: "/stale-parent-directory" };
    if (mode === "environment") environment.OPENROUTER_API_KEY = credential;
    const RED = {
      nodes: {
        getNode: () => ({
          type: "model-provider",
          getProviderConfig: () => ({
            provider: "openrouter",
            apiKey: credential,
            baseURL: "https://openrouter.ai/api/v1",
            defaultModel: "anthropic/test",
            allowedModels: [],
          }),
        }),
      },
    };
    const adapter = new OpenCodeAdapter({ fixedVersion: 2 });
    const build = adapter.buildExecution.bind(adapter);
    // Replace only the executable with a diagnostic child; retain adapter argv/env/cwd.
    adapter.buildExecution = (resolved) => {
      const built = build(resolved);
      return {
        ...built,
        command: process.execPath,
        args: [
          "-e",
          `console.log(JSON.stringify({type:'text',part:{text:JSON.stringify({
            cwd:process.cwd(), pwd:process.env.PWD, args:process.argv.slice(1),
            authenticated:process.env.OPENROUTER_API_KEY === '${credential}'
          })}}));`,
          "--",
          ...built.args,
        ],
      };
    };
    const result = await runAgent({
      adapter,
      runtime: new DirectRuntime(),
      resolved: { ...prompt, cwd, timeoutMs: 5000 },
      executionId: `s1-${label}`,
      resolveAuth: () =>
        resolveCLIAuth(
          RED,
          {
            agent: "opencode-v2",
            authMode: mode,
            model: mode === "environment" ? "openrouter/anthropic/test" : "",
          },
          environment,
        ),
    });
    assert.equal(result.status, "completed");
    const child = JSON.parse(result.payload);
    assert.equal(child.cwd, expected);
    assert.equal(child.pwd, expected);
    assert.equal(child.authenticated, true);
    assert.deepEqual(child.args, [
      "run",
      "--standalone",
      "--format",
      "json",
      "--model",
      "openrouter/anthropic/test",
      prompt.prompt,
    ]);
    assert.equal(environment.PWD, "/stale-parent-directory");
    assert.ok(!JSON.stringify(result).includes(credential));
  });
}

test("SRT receives the private v2 execution with its effective cwd and environment", async () => {
  const srt = new SrtRuntime({ settingsPath: "/s1/settings.json" });
  await runAgent({
    adapter: new OpenCodeAdapter({ fixedVersion: 2 }),
    runtime: {
      execute(request) {
        const wrapped = srt.buildCommand(request);
        assert.equal(wrapped.cmd, "srt");
        assert.deepEqual(wrapped.args, [
          "-s",
          "/s1/settings.json",
          "opencode",
          "run",
          "--standalone",
          "--format",
          "json",
          prompt.prompt,
        ]);
        assert.equal(request.cwd, os.tmpdir());
        assert.equal(request.env.PWD, os.tmpdir());
        assert.deepEqual(request.cancellation, { signal: "SIGINT", graceMs: 5000 });
        return { exitCode: 0, signal: null, stderr: "" };
      },
    },
    resolved: { ...prompt, cwd: os.tmpdir() },
    executionId: "s1-srt",
  });
});

test("v1, Pi and Copilot keep inherited PWD and existing lifecycle cwd routing", async () => {
  for (const adapter of [
    new OpenCodeAdapter({ fixedVersion: 1 }),
    new PiAdapter(),
    new CopilotAdapter(),
  ]) {
    for (const cwd of ["", "."]) {
      await runAgent({
        adapter,
        runtime: {
          execute(request) {
            assert.equal(request.cwd, cwd || undefined);
            assert.ok(!request.args.includes("--standalone"));
            assert.equal(request.env.PWD, "/unchanged-parent-directory");
            assert.equal(request.cancellation, undefined);
            return { exitCode: 0, signal: null, stderr: "" };
          },
        },
        resolved: { ...prompt, cwd },
        executionId: "s1-other-adapters",
        resolveAuth: () =>
          resolveCLIAuth(null, { authMode: "default" }, { PWD: "/unchanged-parent-directory" }),
      });
    }
  }
});
