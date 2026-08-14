// Trigger a Node-RED inject node and wait for a specific debug node's
// output, reacting the instant it arrives instead of a fixed sleep+poll.
//
// Usage: node scripts/run-and-watch.js <injectNodeId> <debugNodeId> [maxWaitMs]
//
// Requires Node 22+ (uses the built-in global fetch/WebSocket).
// Env: NODERED_URL (default http://127.0.0.1:1880)
const [injectId, debugId, maxWaitArg] = process.argv.slice(2);
const maxWaitMs = parseInt(maxWaitArg || '60000', 10);
const base = process.env.NODERED_URL || 'http://127.0.0.1:1880';

if (!injectId || !debugId) {
    console.error('usage: node scripts/run-and-watch.js <injectNodeId> <debugNodeId> [maxWaitMs]');
    process.exit(2);
}

const ws = new WebSocket(base.replace(/^http/, 'ws') + '/comms');
let settled = false;

function finish(code) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ws.close();
    process.exit(code);
}

const timer = setTimeout(() => {
    console.error('[watch] TIMEOUT after', maxWaitMs, 'ms with no result');
    finish(1);
}, maxWaitMs);

ws.addEventListener('open', async () => {
    ws.send(JSON.stringify({ subscribe: 'debug' }));
    ws.send(JSON.stringify({ subscribe: 'status/#' }));
    // Give the subscribe a moment to land server-side before firing the
    // inject, so we don't race and miss the first message.
    await new Promise((r) => setTimeout(r, 300));
    const res = await fetch(base + '/inject/' + injectId, { method: 'POST' });
    console.error('[watch] injected', injectId, '->', res.status);
});

ws.addEventListener('message', (ev) => {
    let events;
    try {
        events = JSON.parse(ev.data);
    } catch (e) {
        return;
    }
    for (const e of events) {
        if (e.topic === 'debug' && e.data && e.data.id === debugId) {
            console.log('RESULT:', JSON.stringify(e.data));
            finish(0);
        }
        if (e.topic && e.topic.startsWith('status/') && e.data && e.data.fill === 'red') {
            console.log('ERROR STATUS:', e.topic, JSON.stringify(e.data));
            finish(1);
        }
    }
});

ws.addEventListener('error', (ev) => {
    console.error('[watch] ws error', ev.message || ev);
    finish(1);
});
