'use strict';

// Node-level integration test: loads gh.js into a real Node-RED runtime
// (via node-red-node-test-helper), wires it into a minimal
// inject -> gh -> helper("output") flow, and asserts on the message that
// actually comes out -- exercising the real RED.nodes.createNode/
// registerType/util.evaluateNodeProperty wiring that gh.spec.js's
// hand-rolled fake-red.js (see ../gh.spec.js) cannot, since that fake only
// ever calls gh.js's exported function directly rather than through a real
// runtime + flow. The spawned `gh` binary is still faked via PATH (see
// ../fixtures/gh) -- no real GitHub CLI or network involved.
const path = require('node:path');
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const helper = require('node-red-node-test-helper');
const ghNode = require('../../gh.js');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const originalPath = process.env.PATH;

before(() => {
    process.env.PATH = FIXTURES_DIR + path.delimiter + originalPath;
    return helper.startServer();
});

after(() => {
    process.env.PATH = originalPath;
    return helper.stopServer();
});

afterEach(() => helper.unload());

test('a minimal inject -> gh -> output flow runs the (faked) gh CLI and produces a real Node-RED message', async () => {
    const flow = [
        { id: 'n1', type: 'gh', name: 'gh', command: 'pr', commandType: 'str', args: 'list', argsType: 'str', wires: [['n2']] },
        { id: 'n2', type: 'helper' }
    ];
    await helper.load(ghNode, flow);
    const n1 = helper.getNode('n1');
    const n2 = helper.getNode('n2');

    const received = await new Promise((resolve, reject) => {
        n2.on('input', resolve);
        n1.receive({ payload: 'go' });
        setTimeout(() => reject(new Error('timed out waiting for gh node output')), 5000).unref();
    });

    // The faked `gh` binary (test/fixtures/gh, GH_TEST_MODE=json default)
    // echoes back its own argv as JSON -- gh.js parses that into msg.payload.
    assert.deepEqual(received.payload.argv, ['pr', 'list']);
    assert.equal(received.gh.command, 'pr');
    assert.deepEqual(received.gh.args, ['list']);
    assert.equal(received.gh.exitCode, 0);
});
