'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InstanceRegistry } = require('../lib/registry');

test('register/get/has/delete round-trip, with busy/startedAt/lastUsed defaulted by the registry', () => {
    const registry = new InstanceRegistry();
    assert.equal(registry.has('ses_1'), false);

    registry.register('ses_1', { host: '127.0.0.1', port: 4100, baseUrl: 'http://127.0.0.1:4100' });
    assert.equal(registry.has('ses_1'), true);
    const record = registry.get('ses_1');
    assert.equal(record.busy, false);
    assert.equal(typeof record.startedAt, 'number');
    assert.equal(record.lastUsed, record.startedAt);

    assert.equal(registry.delete('ses_1'), true);
    assert.equal(registry.has('ses_1'), false);
});

test('setBusy toggles the flag and bumps lastUsed, and is a no-op for an untracked sessionID', async () => {
    const registry = new InstanceRegistry();
    registry.register('ses_1', { host: '127.0.0.1', port: 4100, baseUrl: 'http://127.0.0.1:4100' });
    const before = registry.get('ses_1').lastUsed;

    await new Promise((r) => setTimeout(r, 5));
    registry.setBusy('ses_1', true);
    assert.equal(registry.get('ses_1').busy, true);
    assert.ok(registry.get('ses_1').lastUsed >= before);

    registry.setBusy('ses_1', false);
    assert.equal(registry.get('ses_1').busy, false);

    // Untracked sessionID: must not throw, must not create an entry.
    assert.doesNotThrow(() => registry.setBusy('ses_unknown', true));
    assert.equal(registry.has('ses_unknown'), false);
});

test('list()/size() reflect exactly what is tracked', () => {
    const registry = new InstanceRegistry();
    registry.register('ses_1', {});
    registry.register('ses_2', {});
    assert.deepEqual(registry.list().sort(), ['ses_1', 'ses_2']);
    assert.equal(registry.size(), 2);

    registry.delete('ses_1');
    assert.deepEqual(registry.list(), ['ses_2']);
    assert.equal(registry.size(), 1);
});

test('summary() is a pure local snapshot (no network) with correct busy/idle counts', () => {
    const registry = new InstanceRegistry();
    registry.register('ses_busy', { host: 'h', port: 1 });
    registry.register('ses_idle_1', { host: 'h', port: 2 });
    registry.register('ses_idle_2', { host: 'h', port: 3 });
    registry.setBusy('ses_busy', true);

    const summary = registry.summary();
    assert.equal(summary.total, 3);
    assert.equal(summary.busy, 1);
    assert.equal(summary.idle, 2);
    assert.equal(summary.sessions.length, 3);
    const busyEntry = summary.sessions.find((s) => s.sessionID === 'ses_busy');
    assert.equal(busyEntry.busy, true);
});

test('summary() on an empty registry reports all zeros, not an error', () => {
    const registry = new InstanceRegistry();
    assert.deepEqual(registry.summary(), { total: 0, busy: 0, idle: 0, sessions: [] });
});
