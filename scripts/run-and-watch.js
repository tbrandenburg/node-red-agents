// Trigger a Node-RED inject node and wait for a specific debug node's
// output, reacting the instant it arrives instead of a fixed sleep+poll.
//
// Usage: node scripts/run-and-watch.js <injectNodeId> <debugNodeId> [maxWaitMs]
//
// Requires Node 22+ (uses the built-in global fetch/WebSocket).
// Env: NODERED_URL (default http://127.0.0.1:1880)
//
// Thin CLI wrapper around scripts/lib/watch-debug.js's waitForDebug --
// see that module for the actual subscribe/inject/wait logic, also reused
// by the automated smoke/E2E suite (test/integration/).
const { waitForDebug } = require('./lib/watch-debug');

const [injectId, debugId, maxWaitArg] = process.argv.slice(2);
const maxWaitMs = parseInt(maxWaitArg || '60000', 10);
const baseUrl = process.env.NODERED_URL || 'http://127.0.0.1:1880';

if (!injectId || !debugId) {
    console.error('usage: node scripts/run-and-watch.js <injectNodeId> <debugNodeId> [maxWaitMs]');
    process.exit(2);
}

console.error('[watch] injecting', injectId, 'and watching for debug node', debugId);
waitForDebug({ baseUrl, injectId, debugId, maxWaitMs }).then((result) => {
    if (result.ok) {
        console.log('RESULT:', JSON.stringify(result.data));
        process.exit(0);
    }
    if (result.reason === 'timeout') {
        console.error('[watch] TIMEOUT after', maxWaitMs, 'ms with no result');
    } else if (result.reason === 'red-status') {
        console.log('ERROR STATUS:', result.topic, JSON.stringify(result.data));
    } else {
        console.error('[watch] ws error', result.data);
    }
    process.exit(1);
});

