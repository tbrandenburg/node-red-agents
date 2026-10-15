"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { linuxIdentity, signalOwned } = require("../../lib/runtimes/process-ownership");
const { killProcessGroup } = require("../../lib/runtimes/process-exec");

test("exited child never signals its potentially recycled PID or process group", (context) => {
  const signals = [];
  context.mock.method(process, "kill", (...args) => signals.push(args));
  const child = { pid: 9100, exitCode: 0, signalCode: null, kill: () => signals.push("child") };
  killProcessGroup(child, "SIGKILL");
  assert.deepEqual(signals, []);
  child.exitCode = null;
  child.signalCode = "SIGINT";
  killProcessGroup(child, "SIGKILL");
  assert.deepEqual(signals, []);
});

test("recycled descendant PID and leader PGID receive no signals", () => {
  const owned = [{ pid: 9101, group: 9100, started: "10001" }];
  const table = [
    { pid: 9100, group: 9100, started: "20001" },
    { pid: 9101, group: 9100, started: "20002" },
  ];
  const signals = [];
  signalOwned(owned, 9100, table, (...args) => signals.push(args));
  assert.deepEqual(signals, []);
  signalOwned(owned, 9100, [], (...args) => signals.push(args));
  assert.deepEqual(signals, []);
});

test("only individually verified descendants are signalled without a surviving original-group member", () => {
  const owned = [
    { pid: 9101, group: 9100, started: "10001" },
    { pid: 9102, group: 9102, started: "10002" },
  ];
  const signals = [];
  signalOwned(
    owned,
    9100,
    [
      { pid: 9100, group: 9100, started: "20001" },
      { pid: 9101, group: 9200, started: "10001" },
      { pid: 9102, group: 9102, started: "10002" },
    ],
    (...args) => signals.push(args),
  );
  assert.deepEqual(signals, [
    [9101, "SIGKILL"],
    [9102, "SIGKILL"],
  ]);
  assert.ok(
    signals.every(([pid]) => pid > 0),
    "no unverified process group is signalled",
  );
});

test("surviving identity-verified original-group member permits group cleanup after leader exit", () => {
  const owned = [{ pid: 9101, group: 9100, started: "10001" }];
  const signals = [];
  signalOwned(owned, 9100, owned, (...args) => signals.push(args));
  assert.deepEqual(signals, [[-9100, "SIGKILL"]]);
  assert.ok(!signals.some(([pid]) => pid === 9100));
});

test("Linux identity uses start ticks even when process names contain parentheses and spaces", () => {
  const stat = (started) =>
    `9101 (tool (name) with spaces) S 9100 9100 ${"0 ".repeat(16)}${started} 0`;
  const first = linuxIdentity(9101, () => stat("10001"));
  const reused = linuxIdentity(9101, () => stat("10002"));
  assert.deepEqual(first, { pid: 9101, parent: 9100, group: 9100, started: "10001" });
  assert.notEqual(first.started, reused.started);
  assert.equal(
    linuxIdentity(9101, () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    }),
    null,
  );
});
