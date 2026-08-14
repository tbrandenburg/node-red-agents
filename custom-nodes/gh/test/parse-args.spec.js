'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../lib/parse-args');

test('splits plain whitespace-separated args', () => {
    assert.deepEqual(parseArgs('list --state open --json number,title,url'), [
        'list', '--state', 'open', '--json', 'number,title,url'
    ]);
});

test('keeps a double-quoted span as one argument', () => {
    assert.deepEqual(parseArgs('list --label "needs review" --limit 10'), [
        'list', '--label', 'needs review', '--limit', '10'
    ]);
});

test('keeps a single-quoted span as one argument', () => {
    assert.deepEqual(parseArgs("list --label 'needs review'"), [
        'list', '--label', 'needs review'
    ]);
});

test('collapses repeated whitespace', () => {
    assert.deepEqual(parseArgs('list    --state   open'), ['list', '--state', 'open']);
});

test('empty and whitespace-only strings yield no arguments', () => {
    assert.deepEqual(parseArgs(''), []);
    assert.deepEqual(parseArgs('   '), []);
});

test('null/undefined yield no arguments', () => {
    assert.deepEqual(parseArgs(undefined), []);
    assert.deepEqual(parseArgs(null), []);
});

test('non-string input throws', () => {
    assert.throws(() => parseArgs(42));
    assert.throws(() => parseArgs(['already', 'an', 'array']));
});

test('shell metacharacters are passed through as literal argv, never interpreted', () => {
    assert.deepEqual(parseArgs('pr list && rm -rf /'), [
        'pr', 'list', '&&', 'rm', '-rf', '/'
    ]);
    assert.deepEqual(parseArgs('pr list; echo pwned'), ['pr', 'list;', 'echo', 'pwned']);
    assert.deepEqual(parseArgs('pr list | cat'), ['pr', 'list', '|', 'cat']);
    assert.deepEqual(parseArgs('pr list `whoami`'), ['pr', 'list', '`whoami`']);
});

test('an unterminated quote fails safe by keeping the rest as literal text', () => {
    assert.deepEqual(parseArgs('list --label "needs review'), ['list', '--label', 'needs review']);
});

test('adjacent quoted and unquoted text joins into a single argument', () => {
    assert.deepEqual(parseArgs('--json"a,b"'), ['--jsona,b']);
});
