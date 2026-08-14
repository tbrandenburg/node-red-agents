'use strict';

// Pure function computing the node.status() shape from the registry's local
// summary (see lib/registry.js). Kept separate from agent-server.js so it's
// unit-testable without a Node-RED runtime -- same reasoning as the `agent`
// package's lib/execution/status.js.
function computeNodeStatus({ total, busy, idle }) {
    if (total === 0) return {}; // no daemons tracked -- idle, nothing to show

    let text = `${total} daemon${total === 1 ? '' : 's'}`;
    text += busy > 0 ? ` \u00b7 ${busy} busy` : ' \u00b7 idle';
    return { fill: busy > 0 ? 'blue' : 'green', shape: 'dot', text };
}

module.exports = { computeNodeStatus };
