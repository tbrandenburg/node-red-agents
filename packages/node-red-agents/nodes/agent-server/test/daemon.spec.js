'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildCommand, spawnDaemon, waitForHealthy, killDaemon } = require('../lib/daemon');
const { findFreePort } = require('../lib/port');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'fake-opencode.js');

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return false;
    }
}

test('buildCommand: direct mode spawns "opencode serve --port <p> --hostname <h>"', () => {
    const { cmd, args } = buildCommand({ hostname: '127.0.0.1', port: 4100 });
    assert.equal(cmd, 'opencode');
    assert.deepEqual(args, ['serve', '--port', '4100', '--hostname', '127.0.0.1']);
});

test('buildCommand: honors a custom binary override', () => {
    const { cmd } = buildCommand({ binary: '/custom/opencode', hostname: '127.0.0.1', port: 4100 });
    assert.equal(cmd, '/custom/opencode');
});

test('buildCommand: srt mode prefixes with "srt -s <settingsPath> opencode serve ..." (same technique as the agent package)', () => {
    const { cmd, args } = buildCommand({
        hostname: '127.0.0.1',
        port: 4100,
        srt: { enabled: true, settingsPath: '/tmp/settings.json' }
    });
    assert.equal(cmd, 'srt');
    assert.deepEqual(args, ['-s', '/tmp/settings.json', 'opencode', 'serve', '--port', '4100', '--hostname', '127.0.0.1']);
});

test('buildCommand: srt mode without a settingsPath omits -s (srt falls back to its own default)', () => {
    const { args } = buildCommand({ hostname: '127.0.0.1', port: 4100, srt: { enabled: true } });
    assert.deepEqual(args, ['opencode', 'serve', '--port', '4100', '--hostname', '127.0.0.1']);
});

test('spawnDaemon + waitForHealthy: a real (fake) daemon becomes healthy, then killDaemon actually kills it', async () => {
    const port = await findFreePort();
    const { child, diagnostics } = spawnDaemon({ binary: FIXTURE, hostname: '127.0.0.1', port });

    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForHealthy(baseUrl, { timeoutMs: 5000, diagnostics });
    assert.equal(health.healthy, true);
    assert.ok(pidAlive(child.pid));

    await killDaemon(child);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(pidAlive(child.pid), false, 'daemon process must not remain alive after killDaemon');
});

test('waitForHealthy rejects with a clear error if nothing is listening within the timeout', async () => {
    const port = await findFreePort();
    await assert.rejects(
        waitForHealthy(`http://127.0.0.1:${port}`, { timeoutMs: 500, intervalMs: 100 }),
        /did not become healthy/
    );
});

test('killDaemon escalates to SIGKILL when the daemon ignores SIGTERM, and still results in it being dead', async () => {
    const port = await findFreePort();
    const { child, diagnostics } = spawnDaemon({
        binary: FIXTURE,
        hostname: '127.0.0.1',
        port,
        env: Object.assign({}, process.env, { FAKE_OPENCODE_IGNORE_SIGTERM: '1' })
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealthy(baseUrl, { timeoutMs: 5000, diagnostics });

    const start = Date.now();
    await killDaemon(child);
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 1900, `expected the SIGKILL escalation grace period (~2s) to have elapsed, got ${elapsed}ms`);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(pidAlive(child.pid), false);
});

test('killDaemon on an already-exited process resolves immediately without throwing', async () => {
    const port = await findFreePort();
    const { child, diagnostics } = spawnDaemon({ binary: FIXTURE, hostname: '127.0.0.1', port });
    await waitForHealthy(`http://127.0.0.1:${port}`, { timeoutMs: 5000, diagnostics });
    await killDaemon(child);

    // Second call on the now-dead child must not throw or hang.
    await killDaemon(child);
});
