'use strict';

// Node-level integration test: loads agent-server.js into a real Node-RED
// runtime (via node-red-node-test-helper) and exercises a minimal
// inject -> agent-server (operation "status") -> helper("output") flow.
// Unlike agent-server's existing unit specs (test/*.spec.js), which call
// lib/ functions directly, this goes through the real
// RED.nodes.createNode/registerType wiring and node.on('input', ...)
// handler exactly as Node-RED itself would invoke it.
//
// Uses the "status" operation with no sessionID (aggregate summary, purely
// local -- see agent-server.js's handleStatusOperation) so this test needs
// no spawned daemon and no fake `opencode` binary at all: it's proving the
// node's real wiring, not re-testing lib/registry.js's logic (already
// unit-tested in test/registry.spec.js and test/status.spec.js).
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const helper = require('node-red-node-test-helper');
const agentServerNode = require('../../agent-server.js');

before(() => helper.startServer());
after(() => helper.stopServer());
afterEach(() => helper.unload());

test('a minimal inject -> agent-server(status) -> output flow returns a real registry summary with no daemons tracked', async () => {
    const flow = [
        { id: 'n1', type: 'agent-server', name: 'agent-server', operation: 'status', wires: [['n2']] },
        { id: 'n2', type: 'helper' }
    ];
    await helper.load(agentServerNode, flow);
    const n1 = helper.getNode('n1');
    const n2 = helper.getNode('n2');

    const received = await new Promise((resolve, reject) => {
        n2.on('input', resolve);
        n1.receive({ payload: 'go' });
        setTimeout(() => reject(new Error('timed out waiting for agent-server node output')), 5000).unref();
    });

    assert.deepEqual(received.payload, { total: 0, busy: 0, idle: 0, sessions: [] });
});
