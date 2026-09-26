"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDaemonAuth } = require("../lib/auth");

test("v1 daemon auth remains disabled unless configured", () => {
  assert.deepEqual(createDaemonAuth("v1"), {});
  assert.deepEqual(createDaemonAuth("v1", { username: "custom", password: "secret" }), {
    username: "custom",
    password: "secret",
  });
});

test("v2 daemon auth uses the fixed username and generates an unexposed per-instance password", () => {
  const auth = createDaemonAuth("v2", { username: "ignored" });
  assert.equal(auth.username, "opencode");
  assert.match(auth.password, /^[0-9a-f]{64}$/);
  assert.notEqual(auth.password, createDaemonAuth("v2").password);
});

test("v2 daemon auth honors a configured password", () => {
  assert.deepEqual(createDaemonAuth("v2", { username: "ignored", password: "configured" }), {
    username: "opencode",
    password: "configured",
  });
});
