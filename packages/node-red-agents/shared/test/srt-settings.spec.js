'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const {
    buildSettingsJson,
    resolveSettingsJsonString,
    writeInlineSettingsFile
} = require('../srt-settings');

// High-signal: srt refuses to run unless all four of these keys are
// *present* (even as empty arrays) -- verified empirically against the
// real srt binary ("network.allowedDomains: Required" etc. when missing).
test('buildSettingsJson always includes all four required keys, even with no input at all', () => {
    const json = buildSettingsJson();
    assert.deepEqual(json, {
        network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
        filesystem: { allowWrite: [], denyRead: [], denyWrite: [] }
    });
});

test('buildSettingsJson carries through configured domains/write dirs', () => {
    const json = buildSettingsJson({
        allowedDomains: ['api.githubcopilot.com'],
        allowedWriteDirs: ['.', '/tmp'],
        strictAllowlist: false
    });
    assert.deepEqual(json.network.allowedDomains, ['api.githubcopilot.com']);
    assert.deepEqual(json.filesystem.allowWrite, ['.', '/tmp']);
    assert.equal(json.network.strictAllowlist, false);
    // deniedDomains/denyRead/denyWrite are always present and empty --
    // we never generate a deny-all, which is exactly what silently broke
    // an earlier hand-written settings file during initial development.
    assert.deepEqual(json.network.deniedDomains, []);
    assert.deepEqual(json.filesystem.denyRead, []);
    assert.deepEqual(json.filesystem.denyWrite, []);
});

test('resolveSettingsJsonString builds from structured fields when no advanced JSON is given', () => {
    const str = resolveSettingsJsonString({ allowedDomains: ['opencode.ai'], allowedWriteDirs: ['.'] });
    const parsed = JSON.parse(str);
    assert.deepEqual(parsed.network.allowedDomains, ['opencode.ai']);
});

test('advanced JSON, when set, fully replaces the structured fields (structured inputs ignored)', () => {
    const advanced = JSON.stringify({
        network: { allowedDomains: ['from-advanced.example'], deniedDomains: [] },
        filesystem: { allowWrite: [], denyRead: [], denyWrite: [] }
    });
    const str = resolveSettingsJsonString({
        allowedDomains: ['should-be-ignored.example'],
        allowedWriteDirs: ['should-be-ignored'],
        advancedJson: advanced
    });
    const parsed = JSON.parse(str);
    assert.deepEqual(parsed.network.allowedDomains, ['from-advanced.example']);
});

test('invalid advanced JSON throws a clear, catchable error rather than writing garbage', () => {
    assert.throws(() => resolveSettingsJsonString({ advancedJson: '{not valid json' }), SyntaxError);
});

test('writeInlineSettingsFile actually writes the resolved JSON to a real file and returns its path', () => {
    const filePath = writeInlineSettingsFile('test-node-id', {
        allowedDomains: ['example.com'],
        allowedWriteDirs: ['.', '/tmp']
    });
    try {
        assert.ok(fs.existsSync(filePath));
        assert.ok(filePath.startsWith(os.tmpdir()));
        assert.ok(filePath.includes('test-node-id'));
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        assert.deepEqual(parsed.network.allowedDomains, ['example.com']);
        assert.deepEqual(parsed.filesystem.allowWrite, ['.', '/tmp']);
    } finally {
        fs.rmSync(filePath, { force: true });
    }
});

test('writeInlineSettingsFile throws (without writing a file) when advanced JSON is invalid', () => {
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('srt-settings-bad-node-'));
    assert.throws(() => writeInlineSettingsFile('bad-node', { advancedJson: '{{{' }));
    const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('srt-settings-bad-node-'));
    assert.equal(after.length, before.length, 'no file should be left behind on validation failure');
});

// Two consumers (agent, agent-server) share this module but must never
// collide on the same temp file for the same nodeId -- each passes its own
// filePrefix.
test('a custom filePrefix produces a distinctly-named temp file, isolated from the default prefix', () => {
    const filePath = writeInlineSettingsFile('shared-node-id', { allowedDomains: ['x.example'] }, 'agent-server-srt-settings');
    try {
        assert.ok(fs.existsSync(filePath));
        assert.ok(require('node:path').basename(filePath).startsWith('agent-server-srt-settings-shared-node-id-'));
    } finally {
        fs.rmSync(filePath, { force: true });
    }
});
