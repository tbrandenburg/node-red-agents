"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ExecutionScheduler } = require("../../lib/execution/scheduler");

// A controllable "task": onStart returns a promise that only resolves when
// the test explicitly calls resolve(), so we can assert mid-flight state.
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("concurrency=1: only one item runs at a time, the rest queue in FIFO order", () => {
  const started = [];
  const pending = new Map();
  const scheduler = new ExecutionScheduler({
    concurrency: 1,
    onStart: (item) => {
      started.push(item.executionId);
      const d = deferred();
      pending.set(item.executionId, d);
      return d.promise;
    },
  });

  scheduler.submit({ executionId: "A" });
  scheduler.submit({ executionId: "B" });
  scheduler.submit({ executionId: "C" });

  assert.deepEqual(started, ["A"]);
  assert.equal(scheduler.activeCount, 1);
  assert.equal(scheduler.queuedCount, 2);

  pending.get("A").resolve();
});

test("concurrency=2: two start immediately, the rest queue; finishing either one starts the next", async () => {
  const started = [];
  const pending = new Map();
  const scheduler = new ExecutionScheduler({
    concurrency: 2,
    onStart: (item) => {
      started.push(item.executionId);
      const d = deferred();
      pending.set(item.executionId, d);
      return d.promise;
    },
  });

  scheduler.submit({ executionId: "A" });
  scheduler.submit({ executionId: "B" });
  scheduler.submit({ executionId: "C" });
  scheduler.submit({ executionId: "D" });

  assert.deepEqual(started, ["A", "B"]);
  assert.equal(scheduler.activeCount, 2);
  assert.equal(scheduler.queuedCount, 2);

  // Finish B (the second one, not strictly the oldest) -- proves it's not
  // just "wait for A specifically".
  pending.get("B").resolve();
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(started, ["A", "B", "C"]);
  assert.equal(scheduler.activeCount, 2);
  assert.equal(scheduler.queuedCount, 1);

  pending.get("A").resolve();
  pending.get("C").resolve();
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(started, ["A", "B", "C", "D"]);
  assert.equal(scheduler.queuedCount, 0);

  pending.get("D").resolve();
});

test("onQueued is called exactly once per item that has to wait, never for items that start immediately", () => {
  const queued = [];
  const pending = new Map();
  const scheduler = new ExecutionScheduler({
    concurrency: 1,
    onStart: (item) => {
      const d = deferred();
      pending.set(item.executionId, d);
      return d.promise;
    },
    onQueued: (item) => queued.push(item.executionId),
  });

  scheduler.submit({ executionId: "A" });
  scheduler.submit({ executionId: "B" });
  scheduler.submit({ executionId: "C" });

  assert.deepEqual(queued, ["B", "C"]);
  pending.get("A").resolve();
});

test("onSettled fires after both the active-map removal and any queue advance have happened", async () => {
  const settledSnapshots = [];
  const pending = new Map();
  const scheduler = new ExecutionScheduler({
    concurrency: 1,
    onStart: (item) => {
      const d = deferred();
      pending.set(item.executionId, d);
      return d.promise;
    },
    onSettled: (item) => {
      settledSnapshots.push({
        id: item.executionId,
        active: scheduler.activeCount,
        queued: scheduler.queuedCount,
      });
    },
  });

  scheduler.submit({ executionId: "A" });
  scheduler.submit({ executionId: "B" });

  pending.get("A").resolve();
  await new Promise((r) => setImmediate(r));

  // By the time onSettled(A) fires, B should already be active (queue
  // advanced) -- this is exactly the ordering agent.js's status render
  // depends on.
  assert.deepEqual(settledSnapshots, [{ id: "A", active: 1, queued: 0 }]);

  pending.get("B").resolve();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(settledSnapshots, [
    { id: "A", active: 1, queued: 0 },
    { id: "B", active: 0, queued: 0 },
  ]);
});

test("drainQueue cancels every still-queued item in FIFO order without ever starting them, and leaves active untouched", () => {
  const started = [];
  const pending = new Map();
  const scheduler = new ExecutionScheduler({
    concurrency: 1,
    onStart: (item) => {
      started.push(item.executionId);
      const d = deferred();
      pending.set(item.executionId, d);
      return d.promise;
    },
  });

  scheduler.submit({ executionId: "A" });
  scheduler.submit({ executionId: "B" });
  scheduler.submit({ executionId: "C" });

  const cancelled = [];
  const removed = scheduler.drainQueue((item) => cancelled.push(item.executionId));

  assert.deepEqual(cancelled, ["B", "C"]);
  assert.equal(removed.length, 2);
  assert.equal(scheduler.queuedCount, 0);
  assert.equal(
    scheduler.activeCount,
    1,
    "A should still be active -- drainQueue must not touch it",
  );
  assert.deepEqual(started, ["A"], "B/C must never have been started");

  pending.get("A").resolve();
});

test("activeIds() reflects exactly what is currently running", () => {
  const pending = new Map();
  const scheduler = new ExecutionScheduler({
    concurrency: 2,
    onStart: (item) => {
      const d = deferred();
      pending.set(item.executionId, d);
      return d.promise;
    },
  });

  scheduler.submit({ executionId: "A" });
  scheduler.submit({ executionId: "B" });
  assert.deepEqual(scheduler.activeIds().sort(), ["A", "B"]);

  pending.get("A").resolve();
  pending.get("B").resolve();
});

test("defaults to concurrency 1 for invalid/missing configuration (0, negative, non-numeric)", () => {
  assert.equal(new ExecutionScheduler({ onStart: () => Promise.resolve() }).concurrency, 1);
  assert.equal(
    new ExecutionScheduler({ concurrency: 0, onStart: () => Promise.resolve() }).concurrency,
    1,
  );
  assert.equal(
    new ExecutionScheduler({ concurrency: -3, onStart: () => Promise.resolve() }).concurrency,
    1,
  );
  assert.equal(
    new ExecutionScheduler({ concurrency: NaN, onStart: () => Promise.resolve() }).concurrency,
    1,
  );
});

test("cancel() removes a still-queued item without starting it, leaving other queued/active items untouched", () => {
  const started = [];
  const pending = new Map();
  const scheduler = new ExecutionScheduler({
    concurrency: 1,
    onStart: (item) => {
      started.push(item.executionId);
      const d = deferred();
      pending.set(item.executionId, d);
      return d.promise;
    },
  });

  scheduler.submit({ executionId: "A" });
  scheduler.submit({ executionId: "B" });
  scheduler.submit({ executionId: "C" });

  const result = scheduler.cancel("B");
  assert.deepEqual(result.status, "queued");
  assert.equal(result.item.executionId, "B");
  assert.equal(scheduler.queuedCount, 1);
  assert.deepEqual(started, ["A"]);

  pending.get("A").resolve();
});

test('cancel() on an active item reports status "active" and does not remove it', () => {
  const pending = new Map();
  const scheduler = new ExecutionScheduler({
    concurrency: 1,
    onStart: (item) => {
      const d = deferred();
      pending.set(item.executionId, d);
      return d.promise;
    },
  });

  scheduler.submit({ executionId: "A" });
  const result = scheduler.cancel("A");
  assert.deepEqual(result.status, "active");
  assert.equal(result.item.executionId, "A");
  assert.equal(
    scheduler.activeCount,
    1,
    "cancel() must not remove active items -- caller kills the real process itself",
  );

  pending.get("A").resolve();
});

test("cancel() returns null for an unknown executionId", () => {
  const scheduler = new ExecutionScheduler({ onStart: () => Promise.resolve() });
  scheduler.submit({ executionId: "A" });
  assert.equal(scheduler.cancel("does-not-exist"), null);
});
