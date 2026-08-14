'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const {
    buildSettingsJson,
    resolveSettingsJsonString,
    writeInlineSettingsFile
} = require('../lib/srt-settings');

// Ported from custom-nodes/agent/test/runtimes/srt-settings.spec.js -- same
// assertions, against this package's own (deliberately duplicated) copy.
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
});

test('resolveSettingsJsonString builds from structured fields when no advanced JSON is given', () => {
    const str = resolveSettingsJsonString({ allowedDomains: ['opencode.ai'], allowedWriteDirs: ['.'] });
    const parsed = JSON.parse(str);
    assert.deepEqual(parsed.network.allowedDomains, ['opencode.ai']);
});

test('advanced JSON, when set, fully replaces the structured fields', () => {
    const advanced = JSON.stringify({
        network: { allowedDomains: ['from-advanced.example'], deniedDomains: [] },
        filesystem: { allowWrite: [], denyRead: [], denyWrite: [] }
    });
    const str = resolveSettingsJsonString({
        allowedDomains: ['should-be-ignored.example'],
        advancedJson: advanced
    });
    assert.deepEqual(JSON.parse(str).network.allowedDomains, ['from-advanced.example']);
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
    } finally {
        fs.rmSync(filePath, { force: true });
    }
});

test('writeInlineSettingsFile throws (without writing a file) when advanced JSON is invalid', () => {
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('agent-server-srt-settings-bad-node-'));
    assert.throws(() => writeInlineSettingsFile('bad-node', { advancedJson: '{{{' }));
    const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('agent-server-srt-settings-bad-node-'));
    assert.equal(after.length, before.length, 'no file should be left behind on validation failure');
});
