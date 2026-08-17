"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeNodeStatus } = require("../lib/status");

test("no daemons tracked -> no status at all", () => {
  assert.deepEqual(computeNodeStatus({ total: 0, busy: 0, idle: 0 }), {});
});

test('daemons tracked but none busy -> green dot, "idle"', () => {
  assert.deepEqual(computeNodeStatus({ total: 2, busy: 0, idle: 2 }), {
    fill: "green",
    shape: "dot",
    text: "2 daemons \u00b7 idle",
  });
});

test("some daemons busy -> blue dot, busy count called out", () => {
  assert.deepEqual(computeNodeStatus({ total: 3, busy: 1, idle: 2 }), {
    fill: "blue",
    shape: "dot",
    text: "3 daemons \u00b7 1 busy",
  });
});

test('singular "daemon" (not "daemons") when total is exactly 1', () => {
  assert.deepEqual(computeNodeStatus({ total: 1, busy: 1, idle: 0 }), {
    fill: "blue",
    shape: "dot",
    text: "1 daemon \u00b7 1 busy",
  });
});
