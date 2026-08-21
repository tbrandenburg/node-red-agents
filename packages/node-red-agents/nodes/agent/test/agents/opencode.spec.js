"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { OpenCodeAdapter } = require("../../lib/agents/opencode");

function baseResolved(overrides) {
  return Object.assign(
    {
      invocation: "prompt",
      prompt: "hello world",
      invocationName: undefined,
      args: undefined,
      cwd: "",
      model: "",
      auto: false,
      sessionID: "",
      mcpServers: [],
    },
    overrides,
  );
}

test("buildExecution: prompt invocation -> positional prompt, no --command", () => {
  const adapter = new OpenCodeAdapter();
  const { command, args } = adapter.buildExecution(
    baseResolved({ prompt: "Fix the failing tests" }),
  );
  assert.equal(command, "opencode");
  assert.deepEqual(args, ["run", "--format", "json", "Fix the failing tests"]);
});

test("buildExecution: skill and command invocation both map to --command <name> <args>", () => {
  const adapter = new OpenCodeAdapter();
  const skillArgs = adapter.buildExecution(
    baseResolved({ invocation: "skill", invocationName: "code-review", args: "focus on security" }),
  ).args;
  const commandArgs = adapter.buildExecution(
    baseResolved({ invocation: "command", invocationName: "review", args: "focus on security" }),
  ).args;

  assert.deepEqual(skillArgs, [
    "run",
    "--format",
    "json",
    "--command",
    "code-review",
    "focus on security",
  ]);
  assert.deepEqual(commandArgs, [
    "run",
    "--format",
    "json",
    "--command",
    "review",
    "focus on security",
  ]);
});

test("buildExecution: no --session flag when sessionID is blank/undefined", () => {
  const adapter = new OpenCodeAdapter();
  assert.deepEqual(adapter.buildExecution(baseResolved({ sessionID: "" })).args, [
    "run",
    "--format",
    "json",
    "hello world",
  ]);
  assert.deepEqual(adapter.buildExecution(baseResolved({ sessionID: undefined })).args, [
    "run",
    "--format",
    "json",
    "hello world",
  ]);
});

test("buildExecution: a present sessionID resumes that session via --session <id>", () => {
  const adapter = new OpenCodeAdapter();
  const { args } = adapter.buildExecution(baseResolved({ sessionID: "ses_abc123" }));
  assert.deepEqual(args, ["run", "--format", "json", "--session", "ses_abc123", "hello world"]);
});

test("buildExecution: --session is also inserted for skill/command invocation", () => {
  const adapter = new OpenCodeAdapter();
  const { args } = adapter.buildExecution(
    baseResolved({
      invocation: "command",
      invocationName: "review",
      args: "x",
      sessionID: "ses_xyz",
    }),
  );
  assert.deepEqual(args, [
    "run",
    "--format",
    "json",
    "--session",
    "ses_xyz",
    "--command",
    "review",
    "x",
  ]);
});

test("buildExecution: cwd, model, and auto map to --dir/--model/--auto", () => {
  const adapter = new OpenCodeAdapter();
  const { args } = adapter.buildExecution(
    baseResolved({ cwd: "/workspace/repo", model: "opencode/big-pickle", auto: true }),
  );
  assert.deepEqual(args, [
    "run",
    "--format",
    "json",
    "--dir",
    "/workspace/repo",
    "--model",
    "opencode/big-pickle",
    "--auto",
    "hello world",
  ]);
});

test("buildExecution: sets OPENCODE_CONFIG_CONTENT only when mcpServers is non-empty", () => {
  const adapter = new OpenCodeAdapter();
  const withoutMcp = adapter.buildExecution(baseResolved());
  assert.equal(withoutMcp.env.OPENCODE_CONFIG_CONTENT, undefined);

  const withMcp = adapter.buildExecution(
    baseResolved({ mcpServers: [{ name: "github", type: "remote", url: "https://x" }] }),
  );
  const parsed = JSON.parse(withMcp.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(parsed, {
    mcp: { github: { type: "remote", url: "https://x", enabled: true } },
  });
});

test("validate: throws on missing prompt / missing skill-or-command name", () => {
  const adapter = new OpenCodeAdapter();
  assert.throws(() => adapter.validate(baseResolved({ prompt: "" })), /non-empty prompt/);
  assert.throws(
    () => adapter.validate(baseResolved({ invocation: "skill", invocationName: "" })),
    /non-empty name/,
  );
});

test("validate: throws a clear error for a non-existent cwd (does not spawn anything)", () => {
  const adapter = new OpenCodeAdapter();
  assert.throws(
    () => adapter.validate(baseResolved({ cwd: "/definitely/does/not/exist/xyz" })),
    /cwd does not exist/,
  );
});

test("validate: accepts a real directory", () => {
  const adapter = new OpenCodeAdapter();
  assert.doesNotThrow(() => adapter.validate(baseResolved({ cwd: os.tmpdir() })));
});

test("validate: rejects malformed mcp server entries", () => {
  const adapter = new OpenCodeAdapter();
  assert.throws(
    () => adapter.validate(baseResolved({ mcpServers: [{ name: "x", type: "remote" }] })),
    /requires a url/,
  );
  assert.throws(
    () => adapter.validate(baseResolved({ mcpServers: [{ name: "x", type: "local" }] })),
    /requires a command/,
  );
});

// High-signal test (1/5): malformed/partial JSONL must never crash the node.
test("parseEvent: drops malformed/blank lines instead of throwing", () => {
  const adapter = new OpenCodeAdapter();
  assert.equal(adapter.parseEvent(""), null);
  assert.equal(adapter.parseEvent("   "), null);
  assert.equal(adapter.parseEvent("{not valid json"), null);
  assert.equal(adapter.parseEvent("not json at all, just a log line"), null);
  assert.equal(adapter.parseEvent('{"type":"text","part":{"text":"hi"'), null); // truncated
});

test("parseEvent: maps real opencode event types onto the generic vocabulary", () => {
  const adapter = new OpenCodeAdapter();
  const stepStart = adapter.parseEvent(JSON.stringify({ type: "step_start", sessionID: "s1" }));
  const toolUse = adapter.parseEvent(JSON.stringify({ type: "tool_use", sessionID: "s1" }));
  const text = adapter.parseEvent(
    JSON.stringify({ type: "text", sessionID: "s1", part: { text: "hi" } }),
  );
  const error = adapter.parseEvent(JSON.stringify({ type: "error", sessionID: "s1" }));

  assert.equal(stepStart.type, "started");
  assert.equal(toolUse.type, "tool");
  assert.equal(text.type, "agent");
  assert.equal(error.type, "failed");
});

test("parseResult: joins text parts, carries sessionID, completed on clean exit", () => {
  const adapter = new OpenCodeAdapter();
  const events = [
    adapter.parseEvent(JSON.stringify({ type: "text", sessionID: "s1", part: { text: "Hello" } })),
    adapter.parseEvent(JSON.stringify({ type: "text", sessionID: "s1", part: { text: "World" } })),
  ];
  const result = adapter.parseResult(events, 0, null, "");
  assert.equal(result.payload, "Hello\nWorld");
  assert.equal(result.sessionID, "s1");
  assert.equal(result.status, "completed");
});

test('parseResult: an {type:"error"} event fails the result even with exitCode 0', () => {
  const adapter = new OpenCodeAdapter();
  const events = [
    adapter.parseEvent(JSON.stringify({ type: "error", sessionID: "s1", error: { name: "Boom" } })),
  ];
  const result = adapter.parseResult(events, 0, null, "");
  assert.equal(result.status, "failed");
  assert.match(result.errorMessage, /Boom/);
});

test("parseResult: non-zero exit code without an error event still fails", () => {
  const adapter = new OpenCodeAdapter();
  const result = adapter.parseResult([], 1, null, "boom on stderr");
  assert.equal(result.status, "failed");
  assert.match(result.errorMessage, /exited with code 1/);
});

test("parseResult: killed by signal fails with a signal-specific message", () => {
  const adapter = new OpenCodeAdapter();
  const result = adapter.parseResult([], null, "SIGKILL", "");
  assert.equal(result.status, "failed");
  assert.match(result.errorMessage, /SIGKILL/);
});

test("parseResult: opencode's generic UnknownError hints at the requested model and surfaces the ref", () => {
  const adapter = new OpenCodeAdapter();
  const events = [
    adapter.parseEvent(
      JSON.stringify({
        type: "error",
        sessionID: "s1",
        error: {
          name: "UnknownError",
          data: { message: "Unexpected server error. Check server logs for details.", ref: "err_abc123" },
        },
      }),
    ),
  ];
  const result = adapter.parseResult(events, 0, null, "", baseResolved({ model: "bogus/model" }));
  assert.equal(result.status, "failed");
  assert.match(result.errorMessage, /ref=err_abc123/);
  assert.match(result.errorMessage, /model "bogus\/model" may not exist/);
  assert.match(result.errorMessage, /opencode models/);
});

test("parseResult: UnknownError with no model set skips the model hint", () => {
  const adapter = new OpenCodeAdapter();
  const events = [
    adapter.parseEvent(
      JSON.stringify({
        type: "error",
        sessionID: "s1",
        error: { name: "UnknownError", data: { message: "Unexpected server error." } },
      }),
    ),
  ];
  const result = adapter.parseResult(events, 0, null, "", baseResolved({ model: "" }));
  assert.equal(result.status, "failed");
  assert.doesNotMatch(result.errorMessage, /may not exist/);
});

test("validate: rejects a model string with no provider/model separator", () => {
  const adapter = new OpenCodeAdapter();
  assert.throws(
    () => adapter.validate(baseResolved({ model: "just-a-model-name" })),
    /expected "provider\/model"/,
  );
});

test("validate: accepts a well-formed provider/model string", () => {
  const adapter = new OpenCodeAdapter();
  assert.doesNotThrow(() => adapter.validate(baseResolved({ model: "github-copilot/claude-sonnet-5" })));
});
