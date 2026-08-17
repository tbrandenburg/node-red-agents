'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const { runProcess } = require('../../lib/runtimes/process-exec');

let idCounter = 0;
function nextId() {
    idCounter += 1;
    return `test-${Date.now()}-${idCounter}`;
}

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return false;
    }
}

// High-signal test (2/5): timeout must escalate SIGTERM -> SIGKILL and must
// never leave an orphan process running. This is the single most important
// safety property of the whole package (spec: "No orphan process should
// remain after timeout").
test('timeout on a SIGTERM-ignoring process escalates to SIGKILL, killing the whole process group', async () => {
    const id = nextId();
    const lines = [];
    const start = Date.now();

    // A process that explicitly ignores SIGTERM, forcing the grace-period
    // SIGKILL escalation path (a plain `sleep` would just die on SIGTERM,
    // never exercising that path).
    const result = await runProcess(
        {
            id,
            cmd: 'bash',
            args: ['-c', 'trap "" TERM; while true; do sleep 0.2; done'],
            timeoutMs: 300
        },
        { onLine: (line) => lines.push(line) }
    );

    const elapsed = Date.now() - start;

    assert.equal(result.timedOut, true);
    assert.equal(result.signal, 'SIGKILL', 'the ignoring process should only die to SIGKILL, not SIGTERM');
    // timeoutMs (300) + GRACE_PERIOD_MS (2000) + scheduling slack
    assert.ok(elapsed < 4000, `expected termination within ~2.3s, took ${elapsed}ms`);
    assert.ok(elapsed >= 300, 'should not terminate before the configured timeout elapses');

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(pidAlive(result.pid), false, 'the spawned process must not remain alive');

    const ps = execSync('ps -eo pid,args').toString();
    assert.ok(!ps.includes('trap "" TERM'), 'no orphan matching the killed command line should remain in the process table');
});

test('a process that exits cleanly before the timeout is not touched', async () => {
    const id = nextId();
    const result = await runProcess({ id, cmd: 'echo', args: ['done'], timeoutMs: 5000 }, {});
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
});

test('no timeoutMs means the process is never killed for taking a while', async () => {
    const id = nextId();
    const start = Date.now();
    const result = await runProcess({ id, cmd: 'sleep', args: ['0.3'] }, {});
    const elapsed = Date.now() - start;
    assert.equal(result.timedOut, false);
    assert.ok(elapsed >= 300);
});

// High-signal test (3/5): args must reach the child process as literal argv
// elements -- never re-interpreted by a shell. Regression-tests the
// "spawn over exec" requirement (spec section 28) for adversarial payloads
// that would be dangerous if ever concatenated into a shell string.
test('adversarial args are passed as literal argv elements, never shell-interpreted (Direct)', async () => {
    const id = nextId();
    const adversarial = [
        'plain',
        'has space',
        `quote"inside`,
        `single'quote`,
        '; rm -rf /tmp/should-not-exist-1 #',
        '$(echo pwned)',
        '`echo pwned`',
        'a && echo pwned',
        'a | echo pwned'
    ];

    let output = '';
    const result = await runProcess(
        {
            id,
            cmd: process.execPath,
            args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...adversarial]
        },
        { onLine: (line) => { output += line; } }
    );

    assert.equal(result.exitCode, 0);
    const received = JSON.parse(output);
    assert.deepEqual(received, adversarial, 'every adversarial string must arrive byte-for-byte as its own argv element');
});

test('terminate() kills a still-running process group on demand', async () => {
    const id = nextId();
    const { terminate } = require('../../lib/runtimes/process-exec');
    const promise = runProcess({ id, cmd: 'sleep', args: ['30'] }, {});

    await new Promise((resolve) => setTimeout(resolve, 100));
    terminate(id);

    const result = await promise;
    assert.notEqual(result.exitCode, 0);
});
