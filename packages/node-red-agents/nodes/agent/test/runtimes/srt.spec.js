'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { SrtRuntime } = require('../../lib/runtimes/srt');

function hasSrt() {
    try {
        execFileSync('srt', ['--version'], { stdio: 'ignore' });
        return true;
    } catch (err) {
        return false;
    }
}

test('buildCommand: prefixes settings/binary flags in front of the wrapped command', () => {
    const runtime = new SrtRuntime({ binary: 'srt', settingsPath: '/tmp/srt-settings.json' });
    const { cmd, args } = runtime.buildCommand({ command: 'opencode', args: ['run', 'hello world'] });
    assert.equal(cmd, 'srt');
    assert.deepEqual(args, ['-s', '/tmp/srt-settings.json', 'opencode', 'run', 'hello world']);
});

test('buildCommand: omits -s when no settingsPath configured (srt falls back to its own default)', () => {
    const runtime = new SrtRuntime({ binary: 'srt' });
    const { args } = runtime.buildCommand({ command: 'echo', args: ['hi'] });
    assert.deepEqual(args, ['echo', 'hi']);
});

// High-signal test (3/5, SRT half): confirms -- against the *actual*
// installed srt binary, not a mock -- that its default (non `-c`) mode is
// argv-safe, which is the whole reason the SRT runtime doesn't need its own
// shell-quoting step. Skips (rather than fails) when `srt` isn't on PATH,
// since SRT is an optional runtime (spec: v1 requires only Direct + SRT
// where available).
test('real srt binary: adversarial args reach the wrapped process as literal argv, not shell-interpreted', { skip: !hasSrt() }, async () => {
    const { runProcess } = require('../../lib/runtimes/process-exec');
    const runtime = new SrtRuntime({});
    const adversarial = ['a; touch /tmp/srt-injection-canary-should-not-exist', '$(echo pwned)', 'has space'];

    const { cmd, args } = runtime.buildCommand({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...adversarial]
    });

    let output = '';
    const result = await runProcess(
        { id: 'srt-injection-' + Date.now(), cmd, args, timeoutMs: 15000 },
        { onLine: (line) => { output += line; } }
    );

    assert.equal(result.exitCode, 0, `srt run failed: ${result.stderr}`);
    const received = JSON.parse(output);
    assert.deepEqual(received, adversarial);

    const fs = require('node:fs');
    assert.equal(fs.existsSync('/tmp/srt-injection-canary-should-not-exist'), false, 'the `;`-separated command must never have executed');
});
