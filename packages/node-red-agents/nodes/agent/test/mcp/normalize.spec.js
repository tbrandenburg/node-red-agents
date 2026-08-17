"use strict";

// High-signal test (4/5): MCP schema translation correctness. If this is
// wrong, opencode silently fails to see configured MCP servers -- with no
// obvious error, since OPENCODE_CONFIG_CONTENT parses fine either way.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toOpenCodeMcp } = require("../../lib/mcp/normalize");

test("normalizes a remote server to opencode's keyed mcp schema", () => {
  const out = toOpenCodeMcp([
    { name: "github", type: "remote", url: "https://mcp.example.com/github" },
  ]);
  assert.deepEqual(out, {
    github: { type: "remote", url: "https://mcp.example.com/github", enabled: true },
  });
});

test("normalizes a local server, folding command+args into one array", () => {
  const out = toOpenCodeMcp([
    {
      name: "filesystem",
      type: "local",
      command: "npx",
      args: ["@modelcontextprotocol/server-filesystem", "/workspace"],
    },
  ]);
  assert.deepEqual(out, {
    filesystem: {
      type: "local",
      command: ["npx", "@modelcontextprotocol/server-filesystem", "/workspace"],
      enabled: true,
    },
  });
});

test("handles multiple servers and preserves order-independent keying by name", () => {
  const out = toOpenCodeMcp([
    { name: "github", type: "remote", url: "https://mcp.example.com/github" },
    { name: "filesystem", type: "local", command: "npx", args: ["x"] },
  ]);
  assert.deepEqual(Object.keys(out).sort(), ["filesystem", "github"]);
});

test("silently skips malformed entries instead of throwing", () => {
  const out = toOpenCodeMcp([
    { name: "", type: "remote", url: "https://x" },
    { name: "no-url", type: "remote" },
    { name: "no-command", type: "local" },
    null,
    undefined,
    { type: "remote", url: "https://x" }, // missing name
  ]);
  assert.deepEqual(out, {});
});

test("non-array input returns an empty object rather than throwing", () => {
  assert.deepEqual(toOpenCodeMcp(undefined), {});
  assert.deepEqual(toOpenCodeMcp(null), {});
  assert.deepEqual(toOpenCodeMcp("not-an-array"), {});
});
