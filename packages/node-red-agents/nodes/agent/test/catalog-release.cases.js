"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../../../../..");

function run(dir, command, args, extra = {}) {
  const result = spawnSync(command, args, {
    cwd: dir,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, ...extra, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.error) throw result.error;
  return result;
}
function git(dir, ...args) {
  const result = run(dir, "git", args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function repo(t, invalidFallback = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-release-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
  await fs.mkdir(path.join(dir, "packages/node-red-agents/nodes/agent"), { recursive: true });
  await fs.copyFile(path.join(root, "Makefile"), path.join(dir, "Makefile"));
  await fs.copyFile(
    path.join(root, "scripts/model-catalog.js"),
    path.join(dir, "scripts/model-catalog.js"),
  );
  const html = await fs.readFile(
    path.join(root, "packages/node-red-agents/nodes/agent/agent.html"),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "packages/node-red-agents/nodes/agent/agent.html"),
    invalidFallback
      ? html.replace(/const MODEL_CATALOG = \{[^\n]*\};/, "const MODEL_CATALOG = {};")
      : html,
  );
  await fs.writeFile(
    path.join(dir, "package.json"),
    '{"name":"fixture","private":true,"workspaces":["packages/*"]}\n',
  );
  await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n");
  await fs.writeFile(
    path.join(dir, "packages/node-red-agents/package.json"),
    '{"name":"release-fixture","version":"1.0.0"}\n',
  );
  const lock = run(dir, "npm", [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  assert.equal(lock.status, 0, lock.stderr);
  await fs.writeFile(
    path.join(dir, "test-make"),
    '#!/bin/sh\nif [ "$1" = test ]; then\n  node -e \'if(require("./packages/node-red-agents/package.json").version!=="1.0.1")process.exit(1)\' || exit 1\n  if [ -z "${BAD_CATALOG:-}" ]; then grep -q \'"fixture","Fixture",\\[\\["fresh"\' packages/node-red-agents/nodes/agent/agent.html || exit 1; fi\n  [ "${FAIL_TEST:-}" != 1 ] || exit 1\nfi\nexit 0\n',
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(dir, "preload.cjs"),
    'global.fetch=async()=>new Response(process.env.BAD_CATALOG ? "{}" : JSON.stringify({fixture:{name:"Fixture",models:{fresh:{id:"fresh",release_date:"2026-01-01"}}}}),{status:200});\n',
  );
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Catalog Test");
  git(dir, "config", "user.email", "catalog-test@example.invalid");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "fixture");
  return dir;
}
function release(dir, extra = {}) {
  return run(dir, "make", ["release", "BUMP=patch", "MAKE=./test-make"], {
    NODE_OPTIONS: `--require=${dir}/preload.cjs`,
    ...extra,
  });
}

test("release refreshes before final-version tests and tags the intended committed tree", async (t) => {
  const dir = await repo(t);
  const base = git(dir, "rev-parse", "HEAD");
  const result = release(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    git(dir, "rev-parse", "node-red-agents@1.0.1^{commit}"),
    git(dir, "rev-parse", "HEAD"),
  );
  assert.equal(git(dir, "rev-parse", "HEAD^"), base);
  assert.match(
    git(dir, "show", "HEAD:packages/node-red-agents/nodes/agent/agent.html"),
    /"fixture","Fixture",\[\["fresh"/,
  );
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("existing tag, failed tests and failed commit never create a new tag", async (t) => {
  for (const scenario of ["tag", "test", "commit"]) {
    const dir = await repo(t);
    const base = git(dir, "rev-parse", "HEAD");
    if (scenario === "tag") git(dir, "tag", "node-red-agents@1.0.1");
    if (scenario === "commit")
      await fs.writeFile(path.join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
    const result = release(dir, scenario === "test" ? { FAIL_TEST: "1" } : {});
    assert.notEqual(result.status, 0, scenario);
    assert.equal(git(dir, "rev-parse", "HEAD"), base, scenario);
    const tag = run(dir, "git", ["rev-parse", "-q", "--verify", "refs/tags/node-red-agents@1.0.1"]);
    assert.equal(tag.status, scenario === "tag" ? 0 : 1, scenario);
  }
});

test("release retains a valid stale snapshot and rejects an invalid fallback", async (t) => {
  for (const invalid of [false, true]) {
    const dir = await repo(t, invalid);
    const before = await fs.readFile(
      path.join(dir, "packages/node-red-agents/nodes/agent/agent.html"),
      "utf8",
    );
    const result = release(dir, { BAD_CATALOG: "1" });
    if (invalid) {
      assert.notEqual(result.status, 0);
      assert.notEqual(
        run(dir, "git", ["rev-parse", "-q", "--verify", "refs/tags/node-red-agents@1.0.1"]).status,
        0,
      );
    } else {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /WARNING.*stale snapshot/);
      assert.equal(
        await fs.readFile(
          path.join(dir, "packages/node-red-agents/nodes/agent/agent.html"),
          "utf8",
        ),
        before,
      );
    }
  }
});

test("failed tag creation leaves the release commit but reports failure without a tag", async (t) => {
  const dir = await repo(t);
  const base = git(dir, "rev-parse", "HEAD");
  await fs.writeFile(
    path.join(dir, ".git/hooks/reference-transaction"),
    '#!/bin/sh\nwhile read old new ref; do\n  if [ "$1" = prepared ] && [ "$ref" = refs/tags/node-red-agents@1.0.1 ]; then exit 1; fi\ndone\nexit 0\n',
    { mode: 0o755 },
  );
  const result = release(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release failed/);
  assert.equal(git(dir, "rev-parse", "HEAD^"), base);
  assert.notEqual(
    run(dir, "git", ["rev-parse", "-q", "--verify", "refs/tags/node-red-agents@1.0.1"]).status,
    0,
  );
});
