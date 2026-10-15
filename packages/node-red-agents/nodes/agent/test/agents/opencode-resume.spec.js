"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { OpenCodeAdapter } = require("../../lib/agents/opencode");
const { runProcess } = require("../../lib/runtimes/process-exec");
const { detectOpenCodeMajorVersion } = require("../../../../shared/opencode-version");

async function profile(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-s6-test-"));
  const binary = path.join(root, "opencode");
  const env = { PATH: `${root}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root };
  try {
    await run({ root, binary, env });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const exists of [false, true]) {
  test(`v2 resume wrapper ${exists ? "executes only after existence confirmation" : "rejects unknown IDs before submitting a prompt"}`, async () => {
    await profile(async ({ root, binary, env }) => {
      const calls = path.join(root, "calls.jsonl");
      fs.writeFileSync(
        binary,
        `#!${process.execPath}\nconst fs=require('fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n'); if(args[0]==='api')process.exit(${exists ? 0 : 1}); console.log('submitted');\n`,
        { mode: 0o700 },
      );
      const adapter = new OpenCodeAdapter({ fixedVersion: 2 });
      const built = adapter.buildExecution({
        invocation: "prompt",
        prompt: "literal $(touch injected)",
        sessionID: "ses_unknown;$(touch injected)",
        cwd: root,
      });
      const lines = [];
      const result = await runProcess(
        {
          id: `resume-${exists}`,
          cmd: built.command,
          args: built.args,
          cwd: root,
          env: { ...env, ...built.env },
          timeoutMs: 3000,
          cancellation: built.cancellation,
        },
        { onLine: (line) => lines.push(line) },
      );
      const received = fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
      assert.deepEqual(received[0], [
        "api",
        "--standalone",
        "GET",
        "/api/session/ses_unknown%3B%24(touch%20injected)",
      ]);
      assert.equal(received.length, exists ? 2 : 1);
      assert.equal(result.exitCode, exists ? 0 : 1);
      assert.deepEqual(lines, exists ? ["submitted"] : []);
      assert.equal(fs.existsSync(path.join(root, "injected")), false);
      if (!exists) assert.match(result.stderr, /resume session not found or unavailable/);
      if (exists) assert.equal(received[1].at(-1), "literal $(touch injected)");
    });
  });
}

test("adapter auto detection retries a failed probe, then caches successful v2 detection", async () => {
  await profile(async ({ root, binary, env }) => {
    const counter = path.join(root, "counter");
    fs.writeFileSync(
      binary,
      `#!${process.execPath}\nconst fs=require('fs'); const path=${JSON.stringify(counter)}; const count=fs.existsSync(path)?Number(fs.readFileSync(path,'utf8')):0;fs.writeFileSync(path,String(count+1));if(count===0)process.exit(1);console.log('2.0.28');\n`,
      { mode: 0o700 },
    );
    const modulePath = require.resolve("../../lib/agents/opencode");
    const result = execFileSync(
      process.execPath,
      [
        "-e",
        `const {OpenCodeAdapter}=require(${JSON.stringify(modulePath)});const adapter=new OpenCodeAdapter();const warnings=[];const resolved={onWarning:value=>warnings.push(value)};console.log(JSON.stringify({versions:[adapter.resolveVersion(resolved),adapter.resolveVersion(resolved),adapter.resolveVersion(resolved)],warnings:warnings.length}));`,
      ],
      { env, encoding: "utf8", timeout: 5000 },
    );
    assert.deepEqual(JSON.parse(result), { versions: [1, 2, 2], warnings: 1 });
    assert.equal(fs.readFileSync(counter, "utf8"), "2");
  });
});

test("version detection bounds a real hanging version process", async () => {
  await profile(async ({ binary }) => {
    fs.writeFileSync(binary, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
    const started = Date.now();
    assert.throws(() => detectOpenCodeMajorVersion({ binary, timeoutMs: 100 }), /failed to detect/);
    assert.ok(Date.now() - started < 1500);
  });
});
