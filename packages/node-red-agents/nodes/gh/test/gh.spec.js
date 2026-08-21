"use strict";

const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeRED } = require("./fake-red");

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const originalPath = process.env.PATH;

// Prepend the fixtures dir so `gh` resolves to test/fixtures/gh instead of
// any real GitHub CLI on the host.
process.env.PATH = FIXTURES_DIR + path.delimiter + originalPath;

function loadNode() {
  delete require.cache[require.resolve("../gh.js")];
  const { RED, getRegistered } = makeFakeRED();
  require("../gh.js")(RED);
  const { ctor } = getRegistered();
  return ctor;
}

function createNode(ctor, config) {
  return new ctor(
    Object.assign({ name: "", commandType: "str", argsType: "str", repoType: "str" }, config),
  );
}

function runInput(node, msg) {
  return new Promise((resolve) => {
    const send = (m) => {
      resolve({ sent: m });
    };
    const done = (err) => {
      resolve({ err });
    };
    node.emit("input", msg, send, done);
  });
}

test.after(() => {
  process.env.PATH = originalPath;
});

test("static command/args execution: constructs correct argv and parses JSON stdout", async () => {
  const ctor = loadNode();
  const node = createNode(ctor, {
    command: "pr",
    args: "list --state open --json number,title,url",
  });
  const { sent } = await runInput(node, {});
  assert.ok(sent, "expected a sent message, not an error");
  assert.deepEqual(sent.payload.argv, [
    "pr",
    "list",
    "--state",
    "open",
    "--json",
    "number,title,url",
  ]);
  assert.equal(sent.gh.command, "pr");
  assert.equal(sent.gh.exitCode, 0);
});

test("msg.gh.command overrides the configured command", async () => {
  const ctor = loadNode();
  const node = createNode(ctor, { command: "pr", args: "list" });
  const { sent } = await runInput(node, { gh: { command: "issue" } });
  assert.equal(sent.gh.command, "issue");
  // args still come from node config since msg.gh.args wasn't set
  assert.deepEqual(sent.payload.argv, ["issue", "list"]);
});

test("msg.gh.args as an array bypasses argument parsing entirely", async () => {
  const ctor = loadNode();
  const node = createNode(ctor, { command: "pr" });
  const { sent } = await runInput(node, { gh: { args: ["view", "42", "--json", "number,title"] } });
  assert.deepEqual(sent.payload.argv, ["pr", "view", "42", "--json", "number,title"]);
});

test("quoted arguments in a string config stay as one argument", async () => {
  const ctor = loadNode();
  const node = createNode(ctor, { command: "pr", args: 'list --label "needs review" --limit 10' });
  const { sent } = await runInput(node, {});
  assert.deepEqual(sent.payload.argv, ["pr", "list", "--label", "needs review", "--limit", "10"]);
});

test("plain-text (non-JSON) stdout is passed through as a string", async () => {
  process.env.GH_TEST_MODE = "text";
  try {
    const ctor = loadNode();
    const node = createNode(ctor, { command: "pr", args: "list" });
    const { sent } = await runInput(node, {});
    assert.equal(sent.payload, "plain text output");
  } finally {
    delete process.env.GH_TEST_MODE;
  }
});

test("non-zero exit code produces an error via done(), no sent message", async () => {
  process.env.GH_TEST_MODE = "fail";
  try {
    const ctor = loadNode();
    const node = createNode(ctor, { command: "pr", args: "view 999" });
    const { sent, err } = await runInput(node, {});
    assert.equal(sent, undefined);
    assert.ok(err instanceof Error);
    assert.equal(err.exitCode, 3);
    assert.match(err.stderr, /boom/);
    assert.equal(err.errorType, "unknown");
    // must not leak the whole environment into the error
    assert.equal(Object.prototype.hasOwnProperty.call(err, "env"), false);
  } finally {
    delete process.env.GH_TEST_MODE;
  }
});

test("auth-related stderr is classified as errorType 'auth'", async () => {
  process.env.GH_TEST_MODE = "fail-auth";
  try {
    const ctor = loadNode();
    const node = createNode(ctor, { command: "pr", args: "list" });
    const { sent, err } = await runInput(node, {});
    assert.equal(sent, undefined);
    assert.equal(err.errorType, "auth");
  } finally {
    delete process.env.GH_TEST_MODE;
  }
});

test("missing gh executable surfaces a clear error instead of crashing", async () => {
  const ctor = loadNode();
  const node = createNode(ctor, { command: "pr", args: "list" });
  const emptyDir = path.join(__dirname, "fixtures-empty-nonexistent");
  const savedPath = process.env.PATH;
  process.env.PATH = emptyDir; // deliberately not containing `gh`
  try {
    const { sent, err } = await runInput(node, {});
    assert.equal(sent, undefined);
    assert.ok(err instanceof Error);
    assert.match(err.message, /not found/);
  } finally {
    process.env.PATH = savedPath;
  }
});

test("timeout kills the child and surfaces an error", async () => {
  process.env.GH_TEST_MODE = "hang";
  try {
    const ctor = loadNode();
    const node = createNode(ctor, { command: "pr", args: "list", timeoutMs: 200 });
    const start = Date.now();
    const { sent, err } = await runInput(node, {});
    const elapsed = Date.now() - start;
    assert.equal(sent, undefined);
    assert.ok(err instanceof Error);
    assert.ok(err.timedOut || /signal/i.test(err.message));
    assert.ok(elapsed < 5000, `expected the timeout to fire quickly, took ${elapsed}ms`);
  } finally {
    delete process.env.GH_TEST_MODE;
  }
});

test("GH_REPO is propagated from the repo config", async () => {
  const ctor = loadNode();
  const node = createNode(ctor, { command: "pr", args: "list", repo: "acme/backend" });
  const { sent } = await runInput(node, {});
  assert.equal(sent.payload.GH_REPO, "acme/backend");
  assert.equal(sent.gh.repo, "acme/backend");
});

test("GH_HOST is propagated from the host config", async () => {
  const ctor = loadNode();
  const node = createNode(ctor, { command: "pr", args: "list", host: "github.example.com" });
  const { sent } = await runInput(node, {});
  assert.equal(sent.payload.GH_HOST, "github.example.com");
  assert.equal(sent.gh.host, "github.example.com");
});

test("msg.gh.repo overrides the configured repo", async () => {
  const ctor = loadNode();
  const node = createNode(ctor, { command: "pr", args: "list", repo: "acme/backend" });
  const { sent } = await runInput(node, { gh: { repo: "acme/frontend" } });
  assert.equal(sent.payload.GH_REPO, "acme/frontend");
});

test("unrelated msg properties are preserved on the sent message", async () => {
  const ctor = loadNode();
  const node = createNode(ctor, { command: "pr", args: "list" });
  const { sent } = await runInput(node, { topic: "my-topic", correlationId: "abc-123" });
  assert.equal(sent.topic, "my-topic");
  assert.equal(sent.correlationId, "abc-123");
});

test("shell metacharacters in args are passed to gh literally, never interpreted", async () => {
  const ctor = loadNode();
  const node = createNode(ctor, { command: "pr", args: "list && rm -rf /" });
  const { sent } = await runInput(node, {});
  // the fake gh just echoes argv back -- if a shell had interpreted
  // this, `gh` would never have been invoked with these as literal args
  assert.deepEqual(sent.payload.argv, ["pr", "list", "&&", "rm", "-rf", "/"]);
});

test('rejects a command value that is "gh" itself', async () => {
  const ctor = loadNode();
  const node = createNode(ctor, { command: "gh", args: "pr list" });
  const { sent, err } = await runInput(node, {});
  assert.equal(sent, undefined);
  assert.match(err.message, /gh.*is the executable itself/i);
});

test("rejects a command value containing whitespace (a full command line)", async () => {
  const ctor = loadNode();
  const node = createNode(ctor, { command: "pr list", args: "" });
  const { sent, err } = await runInput(node, {});
  assert.equal(sent, undefined);
  assert.match(err.message, /single gh subcommand/i);
});

test("credential-looking values are never present on error metadata", async () => {
  process.env.GH_TEST_MODE = "fail";
  process.env.GH_TOKEN = "super-secret-token-value";
  try {
    const ctor = loadNode();
    const node = createNode(ctor, { command: "pr", args: "view 1" });
    const { err } = await runInput(node, {});
    const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
    assert.ok(!serialized.includes("super-secret-token-value"));
  } finally {
    delete process.env.GH_TEST_MODE;
    delete process.env.GH_TOKEN;
  }
});
