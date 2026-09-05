"use strict";

// Fixed set of capability flags an AgentAdapter subclass may declare via
// a static `CAPABILITIES` object exported alongside the class (see
// opencode.js / pi.js). A flag must reflect wired-up behavior in this
// adapter's buildExecution()/parseResult(), never what the underlying
// CLI could theoretically support if we wired more of it up -- see
// Archon's ProviderCapabilities convention. Missing flags default to
// their listed default (all "unsupported").
const DEFAULT_CAPABILITIES = {
  sessionResume: false,
  structuredOutput: false, // false | "best-effort" | "enforced"
  toolRestrictions: false,
  effortControl: false,
  systemPromptControl: false,
  costReporting: false,
};

function getCapabilities(adapter) {
  return Object.assign({}, DEFAULT_CAPABILITIES, adapter.constructor.CAPABILITIES || {});
}

module.exports = { DEFAULT_CAPABILITIES, getCapabilities };
