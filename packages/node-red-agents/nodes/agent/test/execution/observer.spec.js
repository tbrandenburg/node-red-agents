"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { bounded, inventoryNotice } = require("../../lib/execution/observer");

test("hung callback is bounded without a model execution deadline", async () => {
  await assert.rejects(
    bounded(() => new Promise(() => {}), { type: "execution.started" }, 15, "execution.started"),
    /execution.started timed out after 15ms/,
  );
});

test("inventory retries rejected notices once with the same event ID", async () => {
  const seen = [];
  inventoryNotice(
    (record) => {
      seen.push(record.eventId);
      if (seen.length === 1) throw new Error("outage");
    },
    { type: "node.deployed", eventId: "same-id" },
    () => assert.fail("recovered notice should not log a warning"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["same-id", "same-id"]);
});

test("hung inventory callback returns immediately and warns once without retry", async () => {
  let attempts = 0;
  const warning = new Promise((resolve) => {
    inventoryNotice(
      () => {
        attempts += 1;
        return new Promise(() => {});
      },
      { type: "node.closed", eventId: "hung" },
      resolve,
    );
  });
  assert.match(await warning, /node.closed notice failed:.*timed out/);
  assert.equal(attempts, 1);
});
