'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PiAdapter } = require('../../lib/agents/pi');

function baseResolved(overrides) {
    return Object.assign(
        {
            invocation: 'prompt',
            prompt: 'hello world',
            invocationName: undefined,
            args: undefined,
            cwd: '',
            model: '',
            auto: false,
            mcpServers: []
        },
        overrides
    );
}

test('buildExecution: prompt invocation is a plain positional message, no --auto equivalent exists', () => {
    const adapter = new PiAdapter();
    const { command, args } = adapter.buildExecution(baseResolved({ prompt: 'Fix the failing tests' }));
    assert.equal(command, 'pi');
    // auto:false -> restricted to read-only tools (no permission-prompt to bypass, verified empirically)
    assert.deepEqual(args, ['--no-session', '--mode', 'json', '--tools', 'read,grep,find,ls', 'Fix the failing tests']);
});

test('buildExecution: auto:true drops the --tools restriction entirely', () => {
    const adapter = new PiAdapter();
    const { args } = adapter.buildExecution(baseResolved({ auto: true }));
    assert.ok(!args.includes('--tools'));
});

test('buildExecution: model passes straight through to --model (pi itself parses "provider/id")', () => {
    const adapter = new PiAdapter();
    const { args } = adapter.buildExecution(baseResolved({ model: 'anthropic/claude-sonnet-5' }));
    assert.ok(args.includes('--model'));
    assert.equal(args[args.indexOf('--model') + 1], 'anthropic/claude-sonnet-5');
});

test('buildExecution: skill invocation resolves a path and crafts an explicit-use instruction', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-adapter-test-'));
    fs.mkdirSync(path.join(tmp, '.github', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.github', 'skills', 'code-review.md'), '---\nname: code-review\n---\nreview it');

    const adapter = new PiAdapter();
    const { args } = adapter.buildExecution(
        baseResolved({ invocation: 'skill', invocationName: 'code-review', args: 'focus on security', cwd: tmp })
    );

    const skillFlagIndex = args.indexOf('--skill');
    assert.ok(skillFlagIndex >= 0, '--skill flag should be present');
    const resolvedPath = args[skillFlagIndex + 1];
    assert.equal(resolvedPath, path.join(tmp, '.github', 'skills', 'code-review.md'));

    const message = args[args.length - 1];
    assert.match(message, /Use the "code-review" skill/);
    assert.match(message, /focus on security/);

    fs.rmSync(tmp, { recursive: true, force: true });
});

test('buildExecution: command invocation uses --prompt-template and the .github/prompts convention', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-adapter-test-'));
    fs.mkdirSync(path.join(tmp, '.github', 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.github', 'prompts', 'review.md'), 'Review $ARGUMENTS');

    const adapter = new PiAdapter();
    const { args } = adapter.buildExecution(
        baseResolved({ invocation: 'command', invocationName: 'review', args: '42', cwd: tmp })
    );

    const flagIndex = args.indexOf('--prompt-template');
    assert.ok(flagIndex >= 0);
    assert.equal(args[flagIndex + 1], path.join(tmp, '.github', 'prompts', 'review.md'));
    assert.match(args[args.length - 1], /Use the "review" prompt template/);

    fs.rmSync(tmp, { recursive: true, force: true });
});

test('validate: rejects any configured MCP servers (pi has no MCP support)', () => {
    const adapter = new PiAdapter();
    assert.throws(
        () => adapter.validate(baseResolved({ mcpServers: [{ name: 'x', type: 'remote', url: 'https://y' }] })),
        /does not support MCP servers/
    );
});

test('validate: rejects a non-empty sessionID (pi has no session continuation, every run uses --no-session)', () => {
    const adapter = new PiAdapter();
    assert.throws(
        () => adapter.validate(baseResolved({ sessionID: 'ses_abc123' })),
        /does not support session continuation/
    );
    // blank/absent is fine -- that's just "no continuation requested"
    assert.doesNotThrow(() => adapter.validate(baseResolved({ sessionID: '' })));
    assert.doesNotThrow(() => adapter.validate(baseResolved({})));
});

test('validate: throws a clear error when a skill/command file cannot be found', () => {
    const adapter = new PiAdapter();
    assert.throws(
        () => adapter.validate(baseResolved({ invocation: 'skill', invocationName: 'does-not-exist', cwd: os.tmpdir() })),
        /could not find a skill named/
    );
});

test('validate: same missing-prompt/name and bad-cwd checks as OpenCode', () => {
    const adapter = new PiAdapter();
    assert.throws(() => adapter.validate(baseResolved({ prompt: '' })), /non-empty prompt/);
    assert.throws(() => adapter.validate(baseResolved({ cwd: '/definitely/does/not/exist/xyz' })), /cwd does not exist/);
});

test('parseEvent: drops malformed lines and the noisy streaming deltas, keeps completed chunks', () => {
    const adapter = new PiAdapter();
    assert.equal(adapter.parseEvent(''), null);
    assert.equal(adapter.parseEvent('{not valid json'), null);

    const delta = adapter.parseEvent(
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } })
    );
    assert.equal(delta, null, 'per-token deltas should be skipped to avoid flooding output 2');

    const end = adapter.parseEvent(
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'hi' } })
    );
    assert.equal(end.type, 'agent');
});

test('parseEvent: maps session/tool/turn events onto the generic vocabulary and keeps the session id', () => {
    const adapter = new PiAdapter();
    const session = adapter.parseEvent(JSON.stringify({ type: 'session', id: 'sess-123' }));
    const tool = adapter.parseEvent(JSON.stringify({ type: 'tool_execution_start', toolName: 'bash' }));
    const end = adapter.parseEvent(JSON.stringify({ type: 'agent_end', messages: [] }));

    assert.equal(session.type, 'started');
    assert.equal(session.sessionID, 'sess-123');
    assert.equal(tool.type, 'tool');
    assert.equal(end.type, 'completed');
});

test('parseResult: extracts the final assistant text and sessionID from agent_end', () => {
    const adapter = new PiAdapter();
    const events = [
        adapter.parseEvent(JSON.stringify({ type: 'session', id: 'sess-abc' })),
        adapter.parseEvent(
            JSON.stringify({
                type: 'agent_end',
                messages: [
                    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
                    { role: 'assistant', content: [{ type: 'text', text: 'PONG' }] }
                ]
            })
        )
    ];
    const result = adapter.parseResult(events, 0, null, '');
    assert.equal(result.payload, 'PONG');
    assert.equal(result.sessionID, 'sess-abc');
    assert.equal(result.status, 'completed');
});

// High-signal: pi does NOT set a non-zero exit code on a model/API error --
// verified empirically (exit 0, error buried in stopReason). Getting this
// wrong means real failures would silently report as "completed".
test('parseResult: detects failure via stopReason:"error" even though exitCode is 0', () => {
    const adapter = new PiAdapter();
    const events = [
        adapter.parseEvent(
            JSON.stringify({
                type: 'agent_end',
                messages: [
                    {
                        role: 'assistant',
                        stopReason: 'error',
                        errorMessage: '404 DeploymentNotFound',
                        content: []
                    }
                ]
            })
        )
    ];
    const result = adapter.parseResult(events, 0, null, '');
    assert.equal(result.status, 'failed');
    assert.match(result.errorMessage, /DeploymentNotFound/);
});

test('parseResult: no agent_end event at all is treated as a failure, not a silent empty success', () => {
    const adapter = new PiAdapter();
    const result = adapter.parseResult([], 0, null, '');
    assert.equal(result.status, 'failed');
    assert.match(result.errorMessage, /no agent_end event/);
});

test('parseResult: killed by signal / non-zero exit still fail like the OpenCode adapter', () => {
    const adapter = new PiAdapter();
    assert.equal(adapter.parseResult([], null, 'SIGKILL', '').status, 'failed');
    assert.equal(adapter.parseResult([], 1, null, 'boom').status, 'failed');
});
