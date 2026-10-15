"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { OpenCodeAdapter } = require("../../lib/agents/opencode");
const { shouldRetry } = require("../../lib/execution/retry");
const { runAgent } = require("../../lib/execution/lifecycle");
const { resolveCLIAuth } = require("../../../../shared/cli-provider-auth");

const prompt = { invocation: "prompt", prompt: "S5 contract" };

test("v2 permission aliases and deny precedence survive overlapping allow rules", () => {
  const adapter = new OpenCodeAdapter({ fixedVersion: 2 });
  const built = adapter.buildExecution({
    ...prompt,
    allowedTools: ["*", "task", "write", "bash"],
    deniedTools: ["subagent", "patch", "shell"],
  });
  const permissions = JSON.parse(built.env.OPENCODE_CONFIG_CONTENT).agents["node-red-agent-tools"]
    .permissions;
  assert.deepEqual(permissions, [
    { action: "*", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
  ]);
  assert.equal(built.args[built.args.indexOf("--agent") + 1], "node-red-agent-tools");
  const denied = adapter.buildExecution({ ...prompt, deniedTools: ["task", "*"] });
  assert.deepEqual(
    JSON.parse(denied.env.OPENCODE_CONFIG_CONTENT).agents["node-red-agent-tools"].permissions,
    [
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "*", resource: "*", effect: "deny" },
    ],
  );
  const legacy = new OpenCodeAdapter({ fixedVersion: 1 }).buildExecution({
    ...prompt,
    allowedTools: ["task"],
    deniedTools: ["task"],
  });
  assert.deepEqual(
    JSON.parse(legacy.env.OPENCODE_CONFIG_CONTENT).agent["node-red-agent-tools"].tools,
    { task: true },
  );
});

test("v2 model variants are retained or replaced by explicit effort, never appended twice", () => {
  const adapter = new OpenCodeAdapter({ fixedVersion: 2 });
  for (const [model, effort, expected] of [
    ["openrouter/openai/test#low", "", "openrouter/openai/test#low"],
    ["openrouter/openai/test#low", "high", "openrouter/openai/test#high"],
    ["openrouter/openai/test", "high", "openrouter/openai/test#high"],
  ]) {
    adapter.validate({ ...prompt, model, effort });
    const built = adapter.buildExecution({ ...prompt, model, effort });
    assert.equal(built.args[built.args.indexOf("--model") + 1], expected);
    assert.equal(built.args.includes("--variant"), false);
  }
  for (const model of [
    "provider/model#",
    "provider/model#low#high",
    "provider#low/model",
    "provider/#low",
  ]) {
    assert.throws(() => adapter.validate({ ...prompt, model }), /invalid model/);
    assert.throws(
      () => adapter.buildExecution({ ...prompt, model, effort: "high" }),
      /invalid model/,
    );
  }
  assert.throws(
    () => adapter.validate({ ...prompt, model: "provider/model", effort: "low#high" }),
    /invalid OpenCode effort/,
  );
  const legacy = new OpenCodeAdapter({ fixedVersion: 1 }).buildExecution({
    ...prompt,
    model: "provider/model#low",
    effort: "high",
  });
  assert.equal(legacy.args[legacy.args.indexOf("--model") + 1], "provider/model#low");
  assert.equal(legacy.args[legacy.args.indexOf("--variant") + 1], "high");
});

test("v2 errors preserve type/message/status for retries and discard provider response diagnostics", () => {
  const adapter = new OpenCodeAdapter({ fixedVersion: 2 });
  for (const [type, message, status, retry] of [
    ["provider.rate-limit", "Slow down", 429, true],
    ["provider.transport", "Disconnected", undefined, true],
    ["provider.internal", "Unavailable", 503, true],
    ["provider.timeout", "Deadline exceeded", undefined, true],
    ["unknown", "ECONNRESET", undefined, true],
    ["provider.auth", "rate limit", 401, false],
    ["provider.quota", "Slow down", 429, false],
    ["provider.no-route", "model timeout", undefined, false],
    ["permission.rejected", "network error", undefined, false],
    ["aborted", "timeout", undefined, false],
    ["provider.invalid-request", "network error", 400, false],
    ["unknown", "rate limit", 403, false],
  ]) {
    const event = adapter.parseEvent(
      JSON.stringify({
        type: "error",
        sessionID: "ses_s5",
        error: {
          type,
          message,
          ...(status ? { status } : {}),
          response: { body: "synthetic-hidden-body" },
          headers: { authorization: "synthetic-hidden-header" },
        },
      }),
    );
    const result = adapter.parseResult([event], 0, null, "synthetic-hidden-stderr");
    assert.equal(result.status, "failed");
    assert.equal(result.sessionID, "ses_s5");
    assert.equal(result.errorDetail.type, type);
    assert.equal(result.errorDetail.message, message);
    assert.equal(result.errorDetail.status, status);
    assert.equal(shouldRetry(result, "transient"), retry);
    if (!retry) assert.equal(shouldRetry(result, "all"), false);
    assert.ok(!JSON.stringify({ event, result }).includes("synthetic-hidden"));
  }
  for (const line of ["null", "[]", "true", "5", '"string"'])
    assert.equal(adapter.parseEvent(line), null);
});

test("v2 diagnostics pass through real lifecycle secret redaction without losing retry evidence", async () => {
  const secret = "synthetic-s5-provider-secret";
  const events = [];
  const result = await runAgent({
    adapter: new OpenCodeAdapter({ fixedVersion: 2 }),
    runtime: {
      execute(request, callbacks) {
        assert.equal(request.env.OPENROUTER_API_KEY, secret);
        callbacks.onLine(
          JSON.stringify({
            type: "error",
            error: {
              type: "provider.rate-limit",
              message: `Slow down ${secret} Bearer opaque-token`,
              status: 429,
              response: { body: "unregistered-body-secret" },
            },
          }),
        );
        return { exitCode: 1, signal: null, stderr: secret };
      },
    },
    resolved: prompt,
    executionId: "s5-redaction",
    onEvent: (event) => events.push(event),
    resolveAuth: () =>
      resolveCLIAuth(null, { agent: "opencode-v2" }, { OPENROUTER_API_KEY: secret }),
  });
  assert.equal(result.status, "failed");
  assert.equal(shouldRetry(result, "transient"), true);
  assert.match(result.errorMessage, /Slow down \[REDACTED\]/);
  for (const forbidden of [secret, "opaque-token", "unregistered-body-secret"])
    assert.ok(!JSON.stringify({ result, events }).includes(forbidden));
});

test("missing token totals use version-specific output semantics and include cached input", () => {
  for (const [version, expected] of [
    [1, 175],
    [2, 190],
  ]) {
    const adapter = new OpenCodeAdapter({ fixedVersion: version });
    const events = [
      { data: { type: "text", part: { text: "done" } } },
      {
        data: {
          type: "step_finish",
          part: {
            tokens: { input: 100, output: 20, reasoning: 15, cache: { read: 30, write: 5 } },
            cost: 0.01,
          },
        },
      },
      {
        data: {
          type: "step_finish",
          part: { tokens: { total: 20, input: 10, output: 10, reasoning: 5 }, cost: 0.02 },
        },
      },
    ];
    const result = adapter.parseResult(events, 0, null, "");
    assert.equal(result.status, "completed");
    assert.deepEqual(result.tokens, {
      total: expected,
      input: 110,
      output: 30,
      reasoning: 20,
      cache: { read: 30, write: 5 },
    });
    assert.equal(result.costUsd, 0.03);
    const invalid = adapter.parseResult(
      [
        {
          data: {
            type: "step_finish",
            part: {
              cost: Infinity,
              tokens: { input: NaN, output: -1, reasoning: Infinity, total: NaN },
            },
          },
        },
      ],
      0,
      null,
      "",
    );
    assert.equal(invalid.tokens.total, 0);
    assert.equal(invalid.costUsd, undefined);
  }
});
