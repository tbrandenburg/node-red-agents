"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeNodeStatus } = require("../../lib/execution/status");

test('active only -> blue dot, "N running"', () => {
  const status = computeNodeStatus({ active: 2, queued: 0 });
  assert.deepEqual(status, { fill: "blue", shape: "dot", text: "2 running" });
});

test("active + queued -> blue dot, combined text (running/queued counts take precedence over any prior terminal state)", () => {
  const status = computeNodeStatus({ active: 2, queued: 3, lastTerminal: "failed" });
  assert.deepEqual(status, { fill: "blue", shape: "dot", text: "2 running \u00b7 3 queued" });
});

test("idle after a completed run -> green dot", () => {
  const status = computeNodeStatus({ active: 0, queued: 0, lastTerminal: "completed" });
  assert.deepEqual(status, { fill: "green", shape: "dot", text: "completed" });
});

test("idle after a failed run -> red ring, using lastText override when present", () => {
  assert.deepEqual(computeNodeStatus({ active: 0, queued: 0, lastTerminal: "failed" }), {
    fill: "red",
    shape: "ring",
    text: "failed",
  });
  assert.deepEqual(
    computeNodeStatus({ active: 0, queued: 0, lastTerminal: "failed", lastText: "bad config" }),
    {
      fill: "red",
      shape: "ring",
      text: "bad config",
    },
  );
});

test("idle after a timeout -> yellow ring", () => {
  assert.deepEqual(computeNodeStatus({ active: 0, queued: 0, lastTerminal: "timeout" }), {
    fill: "yellow",
    shape: "ring",
    text: "timeout",
  });
});

test("never run and idle -> no status at all", () => {
  assert.deepEqual(computeNodeStatus({ active: 0, queued: 0 }), {});
});

test("queued with zero active (transient edge case) still renders as the running/queued combined form", () => {
  const status = computeNodeStatus({ active: 0, queued: 1 });
  assert.deepEqual(status, { fill: "blue", shape: "dot", text: "0 running \u00b7 1 queued" });
});
