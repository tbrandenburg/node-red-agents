"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_CAPABILITIES, getCapabilities } = require("../../lib/agents/capabilities");
const { OpenCodeAdapter } = require("../../lib/agents/opencode");
const { PiAdapter } = require("../../lib/agents/pi");

test("getCapabilities: adapter with no CAPABILITIES static returns DEFAULT_CAPABILITIES unchanged", () => {
  class NoCapabilitiesAdapter {}
  const result = getCapabilities(new NoCapabilitiesAdapter());
  assert.deepEqual(result, DEFAULT_CAPABILITIES);
});

test("getCapabilities: OpenCodeAdapter returns the merged opencode values", () => {
  const result = getCapabilities(new OpenCodeAdapter());
  assert.deepEqual(result, {
    sessionResume: true,
    structuredOutput: "best-effort",
    toolRestrictions: true,
    effortControl: true,
    systemPromptControl: false,
    costReporting: true,
  });
});

test("getCapabilities: PiAdapter returns the merged pi values", () => {
  const result = getCapabilities(new PiAdapter());
  assert.deepEqual(result, {
    sessionResume: false,
    structuredOutput: "best-effort",
    toolRestrictions: true,
    effortControl: false,
    systemPromptControl: false,
    costReporting: false,
  });
});

test("DEFAULT_CAPABILITIES: all flags default to false", () => {
  assert.deepEqual(DEFAULT_CAPABILITIES, {
    sessionResume: false,
    structuredOutput: false,
    toolRestrictions: false,
    effortControl: false,
    systemPromptControl: false,
    costReporting: false,
  });
});
