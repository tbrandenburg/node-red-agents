"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CopilotAdapter } = require("../../lib/agents/copilot");

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
      systemPrompt: "",
      effort: "",
      allowedTools: [],
      deniedTools: [],
    },
    overrides,
  );
}

test("buildExecution: prompt invocation -> -p <prompt>, base flags always present", () => {
  const adapter = new CopilotAdapter();
  const { command, args } = adapter.buildExecution(
    baseResolved({ prompt: "Fix the failing tests" }),
  );
  assert.equal(command, "copilot");
  assert.deepEqual(args, [
    "--output-format",
    "json",
    "--allow-all-tools",
    "-p",
    "Fix the failing tests",
  ]);
});

test("buildExecution: no --resume flag when sessionID is blank/undefined", () => {
  const adapter = new CopilotAdapter();
  assert.ok(!adapter.buildExecution(baseResolved({ sessionID: "" })).args.includes("--resume"));
  assert.ok(
    !adapter.buildExecution(baseResolved({ sessionID: undefined })).args.includes("--resume"),
  );
});

test("buildExecution: a present sessionID resumes via --resume <id>, never --session-id", () => {
  const adapter = new CopilotAdapter();
  const { args } = adapter.buildExecution(baseResolved({ sessionID: "ses_abc123" }));
  assert.ok(args.includes("--resume"));
  assert.equal(args[args.indexOf("--resume") + 1], "ses_abc123");
  assert.ok(!args.includes("--session-id"));
});

test("buildExecution: cwd and model map to --add-dir/--model", () => {
  const adapter = new CopilotAdapter();
  const { args } = adapter.buildExecution(
    baseResolved({ cwd: "/workspace/repo", model: "claude-sonnet-5" }),
  );
  assert.ok(args.includes("--add-dir"));
  assert.equal(args[args.indexOf("--add-dir") + 1], "/workspace/repo");
  assert.ok(args.includes("--model"));
  assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-5");
});

test("buildExecution: pushes --effort <level> when effort is set", () => {
  const adapter = new CopilotAdapter();
  const withoutEffort = adapter.buildExecution(baseResolved());
  assert.ok(!withoutEffort.args.includes("--effort"));

  const withEffort = adapter.buildExecution(baseResolved({ effort: "high" }));
  assert.ok(withEffort.args.includes("--effort"));
  assert.equal(withEffort.args[withEffort.args.indexOf("--effort") + 1], "high");
});

test("buildExecution: allowedTools/deniedTools map to --allow-tool/--deny-tool", () => {
  const adapter = new CopilotAdapter();
  const withoutTools = adapter.buildExecution(baseResolved());
  assert.ok(!withoutTools.args.some((a) => a.startsWith("--allow-tool")));
  assert.ok(!withoutTools.args.some((a) => a.startsWith("--deny-tool")));

  const withTools = adapter.buildExecution(
    baseResolved({ allowedTools: ["read", "grep"], deniedTools: ["bash"] }),
  );
  assert.ok(withTools.args.includes("--allow-tool=read,grep"));
  assert.ok(withTools.args.includes("--deny-tool=bash"));
});

test("buildExecution: mcpServers set --additional-mcp-config with the mcpServers wrapper", () => {
  const adapter = new CopilotAdapter();
  const withoutMcp = adapter.buildExecution(baseResolved());
  assert.ok(!withoutMcp.args.includes("--additional-mcp-config"));

  const withMcp = adapter.buildExecution(
    baseResolved({
      mcpServers: [{ name: "context7", type: "local", command: "npx", args: ["-y", "pkg"] }],
    }),
  );
  const idx = withMcp.args.indexOf("--additional-mcp-config");
  assert.ok(idx !== -1);
  const parsed = JSON.parse(withMcp.args[idx + 1]);
  assert.deepEqual(parsed, {
    mcpServers: {
      context7: { type: "local", command: "npx", args: ["-y", "pkg"], tools: ["*"] },
    },
  });
});

test("buildExecution: skill and command invocation synthesize a natural-language instruction (no CLI flag)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-adapter-test-"));
  fs.mkdirSync(path.join(tmp, ".github", "skills"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".github", "skills", "code-review.md"),
    "---\nname: code-review\n---\nreview it",
  );

  const adapter = new CopilotAdapter();
  const { args } = adapter.buildExecution(
    baseResolved({
      invocation: "skill",
      invocationName: "code-review",
      args: "focus on security",
      cwd: tmp,
    }),
  );

  assert.ok(!args.includes("--skill"));
  const message = args[args.length - 1];
  assert.match(message, /Use the "code-review" skill/);
  assert.match(message, /focus on security/);
  assert.equal(args[args.length - 2], "-p");

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("buildExecution: command invocation uses the .github/prompts convention", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-adapter-test-"));
  fs.mkdirSync(path.join(tmp, ".github", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".github", "prompts", "review.md"), "Review $ARGUMENTS");

  const adapter = new CopilotAdapter();
  const { args } = adapter.buildExecution(
    baseResolved({ invocation: "command", invocationName: "review", args: "42", cwd: tmp }),
  );
  assert.match(args[args.length - 1], /Use the "review" prompt template/);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("validate: throws on missing prompt / missing skill-or-command name", () => {
  const adapter = new CopilotAdapter();
  assert.throws(() => adapter.validate(baseResolved({ prompt: "" })), /non-empty prompt/);
  assert.throws(
    () => adapter.validate(baseResolved({ invocation: "skill", invocationName: "" })),
    /non-empty name/,
  );
});

test("validate: throws a clear error for a non-existent cwd", () => {
  const adapter = new CopilotAdapter();
  assert.throws(
    () => adapter.validate(baseResolved({ cwd: "/definitely/does/not/exist/xyz" })),
    /cwd does not exist/,
  );
});

test("validate: accepts a real directory", () => {
  const adapter = new CopilotAdapter();
  assert.doesNotThrow(() => adapter.validate(baseResolved({ cwd: os.tmpdir() })));
});

test("validate: accepts a bare (non-provider/model) model id without throwing", () => {
  const adapter = new CopilotAdapter();
  assert.doesNotThrow(() => adapter.validate(baseResolved({ model: "claude-sonnet-5" })));
});

test("validate: rejects malformed mcp server entries", () => {
  const adapter = new CopilotAdapter();
  assert.throws(
    () => adapter.validate(baseResolved({ mcpServers: [{ name: "x", type: "remote" }] })),
    /requires a url/,
  );
  assert.throws(
    () => adapter.validate(baseResolved({ mcpServers: [{ name: "x", type: "local" }] })),
    /requires a command/,
  );
});

test("validate: throws a clear error when a skill/command file cannot be found", () => {
  const adapter = new CopilotAdapter();
  assert.throws(
    () =>
      adapter.validate(
        baseResolved({ invocation: "skill", invocationName: "does-not-exist", cwd: os.tmpdir() }),
      ),
    /could not find a skill named/,
  );
});

// High-signal test: malformed/partial JSONL must never crash the node.
test("parseEvent: drops malformed/blank lines instead of throwing", () => {
  const adapter = new CopilotAdapter();
  assert.equal(adapter.parseEvent(""), null);
  assert.equal(adapter.parseEvent("   "), null);
  assert.equal(adapter.parseEvent("{not valid json"), null);
  assert.equal(adapter.parseEvent("not json at all, just a log line"), null);
});

test("parseEvent: maps real verified copilot event types onto the generic vocabulary", () => {
  const adapter = new CopilotAdapter();
  const turnStart = adapter.parseEvent(
    JSON.stringify({ type: "assistant.turn_start", sessionId: "s1" }),
  );
  const toolStart = adapter.parseEvent(
    JSON.stringify({ type: "tool.execution_start", sessionId: "s1" }),
  );
  const message = adapter.parseEvent(
    JSON.stringify({ type: "assistant.message", sessionId: "s1", data: { content: "hi" } }),
  );
  const result = adapter.parseEvent(
    JSON.stringify({ type: "result", sessionId: "s1", exitCode: 0 }),
  );

  assert.equal(turnStart.type, "started");
  assert.equal(toolStart.type, "tool");
  assert.equal(message.type, "agent");
  assert.equal(result.type, "completed");
  assert.equal(result.sessionID, "s1");
});

test("parseResult: extracts final assistant.message content, sessionID, completed on clean exit", () => {
  const adapter = new CopilotAdapter();
  const events = [
    adapter.parseEvent(
      JSON.stringify({ type: "assistant.message", sessionId: "s1", data: { content: "pong" } }),
    ),
    adapter.parseEvent(
      JSON.stringify({
        type: "result",
        sessionId: "s1",
        exitCode: 0,
        usage: { premiumRequests: 1, totalApiDurationMs: 500, sessionDurationMs: 900 },
      }),
    ),
  ];
  const result = adapter.parseResult(events, 0, null, "");
  assert.equal(result.payload, "pong");
  assert.equal(result.sessionID, "s1");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.tokens, {
    premiumRequests: 1,
    totalApiDurationMs: 500,
    sessionDurationMs: 900,
  });
});

test("parseResult: no usage keys at all when the result event has no usable usage data", () => {
  const adapter = new CopilotAdapter();
  const events = [
    adapter.parseEvent(
      JSON.stringify({ type: "assistant.message", sessionId: "s1", data: { content: "pong" } }),
    ),
    adapter.parseEvent(JSON.stringify({ type: "result", sessionId: "s1", exitCode: 0 })),
  ];
  const result = adapter.parseResult(events, 0, null, "");
  assert.equal(result.status, "completed");
  assert.ok(!("tokens" in result));
  assert.ok(!("costUsd" in result));
});

test("parseResult: clean exit (0) with no assistant.message fails with a zero-output message", () => {
  const adapter = new CopilotAdapter();
  const events = [
    adapter.parseEvent(JSON.stringify({ type: "assistant.turn_end", sessionId: "s1" })),
  ];
  const result = adapter.parseResult(events, 0, null, "");
  assert.equal(result.payload, "");
  assert.equal(result.status, "failed");
  assert.match(result.errorMessage, /no assistant output/);
});

// Real verified failure path: bad --model -> exit code 1, zero further
// JSON stdout lines, stderr = 'Error: Model "bogus-model-xyz" from
// --model flag is not available.'
test("parseResult: bad --model exits 1 with zero JSON output, error surfaced with a model hint", () => {
  const adapter = new CopilotAdapter();
  const result = adapter.parseResult(
    [],
    1,
    null,
    'Error: Model "bogus-model-xyz" from --model flag is not available.',
    baseResolved({ model: "bogus-model-xyz" }),
  );
  assert.equal(result.status, "failed");
  assert.match(result.errorMessage, /exited with code 1/);
  assert.match(result.errorMessage, /not available/);
  assert.match(result.errorMessage, /model "bogus-model-xyz" may not exist/);
});

// Real verified failure path: bad --resume -> exit code 1, zero JSON
// stdout at all, stderr = "Error: No session, task, or name matched
// 'totally-bogus-nonexistent-session-999'." -- must be surfaced as a
// hard failure, never confused with a fresh-session success.
test("parseResult: bad --resume exits 1 with zero JSON output, error surfaced verbatim", () => {
  const adapter = new CopilotAdapter();
  const result = adapter.parseResult(
    [],
    1,
    null,
    "Error: No session, task, or name matched 'totally-bogus-nonexistent-session-999'.",
    baseResolved({ sessionID: "totally-bogus-nonexistent-session-999" }),
  );
  assert.equal(result.status, "failed");
  assert.match(result.errorMessage, /exited with code 1/);
  assert.match(result.errorMessage, /No session, task, or name matched/);
});

test("parseResult: killed by signal fails with a signal-specific message", () => {
  const adapter = new CopilotAdapter();
  const result = adapter.parseResult([], null, "SIGKILL", "");
  assert.equal(result.status, "failed");
  assert.match(result.errorMessage, /SIGKILL/);
});

test("parseResult: a session.error event fails the result even with exitCode 0", () => {
  const adapter = new CopilotAdapter();
  const events = [
    adapter.parseEvent(
      JSON.stringify({ type: "session.error", sessionId: "s1", data: { message: "Boom" } }),
    ),
  ];
  const result = adapter.parseResult(events, 0, null, "");
  assert.equal(result.status, "failed");
  assert.match(result.errorMessage, /Boom/);
});
