'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('__NAME__ module exports a Node-RED registration function', () => {
    const registerType = require('../__NAME__.js');
    assert.equal(typeof registerType, 'function');
});
