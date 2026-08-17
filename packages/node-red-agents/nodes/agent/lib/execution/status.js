"use strict";

// Pure function computing the node.status() shape from current scheduler
// counts plus the last terminal outcome. Kept separate from agent.js so the
// "running/queued counts take precedence" rule (spec section 4) is
// unit-testable without a Node-RED runtime.
//
// lastTerminal: undefined (never run) | 'completed' | 'failed' | 'timeout'
// lastText: optional override for the failed-state text (e.g. 'bad config')
function computeNodeStatus({ active, queued, lastTerminal, lastText }) {
  if (active > 0 || queued > 0) {
    let text = `${active} running`;
    if (queued > 0) text += ` \u00b7 ${queued} queued`;
    return { fill: "blue", shape: "dot", text };
  }

  if (lastTerminal === "completed") return { fill: "green", shape: "dot", text: "completed" };
  if (lastTerminal === "failed") return { fill: "red", shape: "ring", text: lastText || "failed" };
  if (lastTerminal === "timeout") return { fill: "yellow", shape: "ring", text: "timeout" };

  return {}; // idle, never run -- no status
}

module.exports = { computeNodeStatus };
