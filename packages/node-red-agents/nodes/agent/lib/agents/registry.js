"use strict";

const registry = new Map();

// entry: { id, factory }
// factory: () => AgentAdapter instance
function registerAgent(entry) {
  if (registry.has(entry.id)) return; // idempotent, mirrors Archon
  if (typeof entry.factory !== "function") {
    throw new Error(`agent '${entry.id}': factory must be a function`);
  }
  registry.set(entry.id, entry);
}

function isRegisteredAgent(id) {
  return registry.has(id);
}

// Throws a clear, listing error instead of returning undefined -- callers
// (agent.js) must not have to null-check every lookup site.
function getAgentAdapter(id) {
  const entry = registry.get(id);
  if (!entry) {
    throw new Error(
      `unknown agent '${id}'. Registered agents: ${[...registry.keys()].join(", ") || "(none)"}`,
    );
  }
  return entry.factory();
}

function listAgentIds() {
  return [...registry.keys()];
}

// Test-only: clears the registry so adapter-registration tests don't
// leak state across test files.
function resetRegistryForTests() {
  registry.clear();
}

module.exports = {
  registerAgent,
  isRegisteredAgent,
  getAgentAdapter,
  listAgentIds,
  resetRegistryForTests,
};
