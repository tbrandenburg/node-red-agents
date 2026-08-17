'use strict';

// The `agent` node's --model flag accepts a plain "provider/model" string
// (opencode's CLI parses that itself). The HTTP API has no such shorthand --
// POST /session/:id/message's `model` field must be a
// `{ providerID, modelID }` object (verified empirically: passing a plain
// string 400s with "Expected object | null, got \"...\""). This is the
// translation between the two, kept pure/testable and separate from
// agent-server.js.
function parseModel(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const str = String(value);
    const slash = str.indexOf('/');
    if (slash <= 0 || slash === str.length - 1) {
        throw new Error(`invalid model "${str}" -- expected "provider/model" (e.g. "github-copilot/claude-sonnet-4.6")`);
    }
    return { providerID: str.slice(0, slash), modelID: str.slice(slash + 1) };
}

module.exports = { parseModel };
