# Refactoring Plan: Node-RED Agents → Publishable Node Library

Date: 2026-08-17
Status: proposed → in progress

## Goal

Turn `custom-nodes/{agent,agent-server,gh}` from four hand-installed
islands into a single, publishable, FlowFuse-Dashboard-style npm package
(`node-red-agents`, workspace-managed), while:

- keeping `data/` as the untouched local dev userDir (real, unsaved work),
- extracting a separate `demo/` userDir seeded from today's
  `data/flows.json`,
- adding a real test pyramid (unit / node-level integration / smoke E2E)
  that runs offline and gates regressions on every node change,
- never reducing the currently-passing test count at any step.

## Why (see full analysis in session, summarized)

- Current state: each node package (`agent`, `agent-server`) is
  internally well-factored (`lib/` + mirrored `test/`), but there is no
  workspace tying them together, no root test runner, no shared code
  path (duplication has already started: `srt-settings.js` is a verbatim
  copy between `agent` and `agent-server`, admitted in its own comment),
  and every `package.json` is missing publish-required fields
  (license, repository, files, engines, node-red.version).
- FlowFuse's `@flowfuse/node-red-dashboard` ships 27 nodes as **one**
  npm package with shared internals — not a multi-package monorepo. We
  have exactly that shared-internals situation and none of the pressure
  (different release cadence, users wanting one node without another)
  that would justify separate publishable packages.
- `data/flows.json` is documented in this repo's own `.gitignore` /
  AGENTS.md as real, potentially-unsaved user work — it must not also be
  the demo flow or the smoke-test fixture. Three different flows, three
  different pressures (dev sandbox vs. pretty demo vs. ugly-but-precise
  regression check).

## Target layout

```
package.json                 # private root, "workspaces": ["packages/*"]
packages/
  node-red-agents/           # the publishable unit
    package.json             # node-red.nodes: agent, agent-server, gh
    nodes/
      agent/{agent.js,agent.html,lib/**,test/**}
      agent-server/{agent-server.js,agent-server.html,lib/**,test/**}
      gh/{gh.js,gh.html,lib/**,test/**,examples/**}
    shared/
      srt-settings.js        # dedupe target (was duplicated)
      ... (only what a 2nd+ consumer actually needs)
    icons/
    examples/
demo/
  flows.json                 # extracted demo flow, own userDir
  settings.js
test/integration/
  flows/*.json                # smoke flows (inject -> node -> debug)
  *.spec.js                   # programmatic Node-RED boot + run-and-watch
data/                         # untouched: local dev userDir, gitignored flows
```

## Step-by-step plan

1. **Baseline**: record current passing test count per package
   (`node --test` in each of `custom-nodes/{agent,agent-server,gh}`).
   This is the regression floor — no step may reduce it.
2. **Root workspace scaffold**: add `"workspaces": ["packages/*"]` to
   root `package.json`, create `packages/node-red-agents/package.json`
   (empty `node-red.nodes` map for now).
3. **Move `agent`** into `packages/node-red-agents/nodes/agent` via
   `git mv`, fix relative requires, wire into the package's
   `node-red.nodes` map, re-run its suite, confirm count unchanged.
4. **Move `agent-server`** the same way.
5. **Move `gh`** the same way.
6. **Adversarial review milestone A** (subagent): after nodes 3–5 are
   moved and workspace wired — verify no broken requires, no silently
   dropped test files, no lost icons/examples, `npm install` at root
   correctly symlinks the package into `data/node_modules` equivalent.
7. **Correction pass** for any findings from milestone A.
8. **Dedupe shared code**: extract `srt-settings.js` (and only that,
   unless review finds other genuine duplicates) into
   `packages/node-red-agents/shared/`, repoint both consumers, re-run
   full suite unchanged.
9. **Publishability pass**: scope name, `license`, `repository`,
   `files`, `engines.node`, `node-red.version`; verify with
   `npm pack --dry-run` that the tarball contains exactly
   nodes/shared/icons/examples/README — nothing else.
10. **Retire scaffolding cruft**: delete `custom-nodes/example-node`,
    retarget `templates/node-package` + `make new-node-package` to
    scaffold inside the new package layout (`nodes/<name>/` + spec +
    node-red.nodes entry).
11. **Adversarial review milestone B** (subagent): verify publishability
    (tarball contents, required fields), scaffolder produces a loadable
    node end-to-end, Makefile targets still make sense.
12. **Correction pass** for any findings from milestone B.
13. **Extract demo flow**: create `demo/flows.json` + `demo/settings.js`
    from the demo-worthy tabs of current `data/flows.json` (manual
    extraction, not scripted), add `make demo` target running Node-RED
    against `demo/` on a separate port. `data/flows.json` stays as-is.
14. **Add node-level integration tests**: introduce
    `node-red-node-test-helper` as a devDependency of the package,
    add at least one integration spec per node (agent, agent-server, gh)
    that loads the node in a real runtime with a minimal flow and
    asserts on output/status, faking any spawned CLI via a stub on PATH.
15. **Add smoke/E2E harness**: `test/integration/` — a script that
    boots Node-RED programmatically against a throwaway temp userDir,
    deploys a minimal smoke flow per node via `POST /flows`, and reuses
    `scripts/run-and-watch.js`'s subscribe/inject/wait logic to assert
    on the debug event. Wire as `make test-e2e` (separate from
    `make test`, since it may shell out to real `opencode`/`gh` binaries).
16. **Adversarial review milestone C** (subagent): review the full test
    pyramid — are node-level tests real integration (not mocks), do
    smoke flows exercise the actual node code path, does `make test`
    stay offline/CI-safe while `make test-e2e` is clearly separated.
17. **Correction pass** for any findings from milestone C.
18. **Final manual spot-check**: run the present demo flow (post
    extraction, `make demo`) end-to-end using `run-and-watch.js` against
    a real inject/debug pair, by hand, as human-in-the-loop confirmation
    before declaring the refactor complete.

## Baseline (step 1, recorded 2026-08-17)

`node --test` per package, run from `custom-nodes/<name>`:

| package      | pass | fail | skip | total |
|--------------|------|------|------|-------|
| agent        | 73   | 0    | 1    | 74    |
| agent-server | 31   | 0    | 0    | 31    |
| gh           | 27   | 0    | 0    | 27    |

Regression floor: **131 passing, 0 failing** across all packages, at
every subsequent step.

## Milestone A findings + corrections (2026-08-17)

Adversarial subagent review after steps 2-5 found the file moves
themselves were clean (all renames tracked, no lost files, requires all
relative and resolved correctly, 131/130/1 test counts unchanged at both
package and root level), but flagged real breakage and stale docs:

- **Fixed**: `data/package.json` still depended on
  `node-red-contrib-{agent,agent-server,gh}` via `file:../custom-nodes/*`
  — those paths no longer exist. Replaced with a single
  `"node-red-agents": "file:../packages/node-red-agents"` dependency;
  reinstalled, confirmed `data/node_modules/node-red-agents` symlinks to
  `../../packages/node-red-agents`.
- **Fixed**: dangling symlinks `data/node_modules/node-red-contrib-*`
  (pointing at deleted `custom-nodes/*`) removed as part of the above.
- **Fixed**: stale `custom-nodes/...` path references in `README.md`,
  `AGENTS.md`, and `data/nodes/README.md` updated to describe the new
  `packages/node-red-agents/nodes/<name>/` layout (scaffolder-specific
  wording left as-is pending step 10).
- **Fixed**: stale `custom-nodes/agent/...` path mentions in code
  comments (`agent-server/lib/srt-settings.js`, `lib/daemon.js`,
  `test/srt-settings.spec.js`, `gh/icons/gh.svg`) repointed to
  `nodes/agent/...`.
- Confirmed not an issue: `custom-nodes/example-node` untouched; no
  empty/orphaned directories left under `custom-nodes/`; `data/settings.js`
  has no hardcoded node paths.
- Full suite re-verified after corrections: 131 tests, 130 pass, 1 skip,
  0 fail — unchanged.

## Step 8: dedupe srt-settings (2026-08-17)

Extracted `packages/node-red-agents/shared/srt-settings.js` from the two
verbatim copies (`nodes/agent/lib/runtimes/srt-settings.js` and
`nodes/agent-server/lib/srt-settings.js`), which only differed in a
hardcoded temp-file prefix. Added an optional `filePrefix` parameter
(default `'srt-settings'`, unchanged for `agent`; `agent-server` now
passes `'agent-server-srt-settings'` explicitly) so the two consumers'
temp files can never collide, preserving prior on-disk behavior exactly.

Consolidated the two near-identical spec files (7 tests each) into
`shared/test/srt-settings.spec.js` (the more thorough of the two,
verbatim, plus one new test asserting `filePrefix` isolation) — net
14 removed + 8 added = -6 tests, all accounted for (no unique assertion
lost; verified by diffing both original specs). New baseline after
dedup: **125 tests, 124 pass, 1 skip, 0 fail** (was 131/130/1).
`shared/srt-settings.js` covered at 100% (lines/branches/functions).

Also fixed: `package.json`'s test script glob didn't include
`shared/**/test/**/*.spec.js` — root `npm test` was silently only
running 117 (missing the 8 shared tests) until corrected.

## Step 9: publishability pass (2026-08-17)

Added to `packages/node-red-agents/package.json`: `homepage`, `bugs`,
`repository` (derived from the actual `origin` remote,
`github.com/tbrandenburg/nodered-agents`, with `directory` pointing at
the package subfolder), `files` (nodes' `.js`/`.html`/icons/examples +
`gh`'s README + `shared/**/*.js`, explicitly excluding `test/` and
`fixtures/`), and `engines.node: ">=22"` (matches `.nvmrc`).
`node-red.version` (`>=4.0.0`) was already set in step 2.

Added `packages/node-red-agents/README.md` (was missing entirely --
`npm pack` would have shipped a package with no registry-page
description).

Verified with `npm pack --dry-run`: tarball contains exactly 33 files —
all `nodes/**` source + icons + examples + the two READMEs +
`shared/srt-settings.js` + `package.json`. No `test/`, no `fixtures/`,
no `node_modules`, no stray root-level project files (`.made/`,
`prompts/`, `data/`, etc. — those live outside the package directory and
were never at risk, but confirmed absent regardless).

Full suite re-verified unchanged: 125 tests, 124 pass, 1 skip, 0 fail.

## Step 10: retire scaffolding cruft (2026-08-17)

Deleted `custom-nodes/` entirely (only `example-node` remained there,
now redundant -- new nodes belong inside the publishable package).

Retargeted the scaffolder:
- `templates/node-package/package.json` removed (nodes no longer have
  their own `package.json` -- they're registered in
  `packages/node-red-agents/package.json`'s `node-red.nodes` map).
- Added `templates/node-package/__NAME__.spec.js` (a starter `node:test`
  spec asserting the module exports a function) so every scaffolded node
  starts with a test, matching the unit-test-first pattern already used
  by `agent`/`agent-server`/`gh`.
- Added `scripts/register-node.js`, a small idempotent-safe JSON editor
  that adds `"<name>": "nodes/<name>/<name>.js"` to
  `packages/node-red-agents/package.json`'s `node-red.nodes` map
  (JSON.parse/stringify, not a Makefile sed one-liner, so it can refuse
  to clobber an existing entry).
- `make new-node-package NAME=x` now scaffolds
  `packages/node-red-agents/nodes/x/{x.js,x.html,test/x.spec.js}` and
  calls `register-node.js` automatically. No palette-install step is
  needed since the package is already linked into `data/` via workspaces.

Verified end-to-end: ran `make new-node-package NAME=smoke-test-node`,
confirmed the scaffolded test ran and passed as part of `npm test`
(125→126 tests, 124→125 pass), confirmed the entry appeared correctly in
`node-red.nodes`, then removed the throwaway node and its registry entry
and reconfirmed the suite returned to exactly 125/124/1/0.

Updated stale `custom-nodes/` references (deferred from Milestone A) in
`README.md`, `AGENTS.md`, `data/nodes/README.md`, and `.gitignore` to
describe the new scaffolding flow.

## Milestone B findings (2026-08-17)

Adversarial subagent review of the publishability pass and scaffolder
(steps 9-10), independently reproducing every claim: `npm pack --dry-run`
33-file count, all package.json publish fields, deletion of
`custom-nodes/`, scaffolder end-to-end (including running it live,
verifying no `__NAME__` leftovers, confirming the new test is picked up
by root `npm test`, cleaning up, and confirming exact return to
125/124/1/0 baseline), `register-node.js` clobber-refusal on an existing
name (byte-identical `package.json` before/after, exit code 1), no
remaining stale `custom-nodes` references anywhere outside the plan doc
itself, and a sane `git status`. No issues found -- no correction pass
needed for this milestone.

## Step 13: extract demo flow (2026-08-17)

Created `demo/` as a fully separate Node-RED userDir, decoupled from
`data/` (which stays exactly as-is -- never touched, per its own
documented "real, potentially-unsaved work" status):

- `demo/flows.json` -- a copy (not a move) of the current
  `data/flows.json` (all 4 tabs: Playground, Issue Control Center, Chat,
  Advanced Chat -- all directly showcase `agent`/`agent-server`/`gh`
  against a real dashboard UI, so all four qualified as demo-worthy;
  none were dropped).
- `demo/package.json` -- same runtime dependencies as `data/package.json`
  (dashboard, ui-chat, theme, `node-red-agents` via the workspace `file:`
  link) since the flow file requires all of the same node types
  (including `auto_layout_config`, confirmed via grepping `"type"` values
  in the flow JSON).
- `demo/settings.js` -- mirrors `data/settings.js`'s pattern (derives
  `chatDir` from its own `__dirname`) but on a different port (`1881` vs
  `1880`, so both instances can run concurrently) and without
  `nodesDir` (the demo only exercises the published package, not
  `data/nodes/`'s drop-in prototypes).
- `demo/chat/.gitkeep` (mirrors `data/chat/`'s pattern).
- `.gitignore`: added `demo/` equivalents of every `data/` runtime-state
  rule (node_modules, package-lock.json, .config.*.json, chat/* contents,
  pidfile), keeping only `flows.json`, `package.json`, `settings.js`,
  `chat/.gitkeep` tracked.
- `Makefile`: added `demo-install` (installs `demo/`'s deps),
  `demo` (runs Node-RED against `demo/` in the background, depends on
  `demo-install`), `demo-stop` (mirrors `stop`'s process-group kill).

Verified end-to-end: `make demo-install` succeeded; `make demo`
backgrounded a Node-RED instance on port 1881 with no errors in the log
(dashboard started, flows started); `curl http://127.0.0.1:1881/flows`
confirmed all 190 nodes loaded; `make demo-stop` cleanly stopped it.
Confirmed `data/flows.json` byte-identical to before (never touched) and
`git add -n demo/` shows exactly the 4 intended tracked files (everything
else correctly gitignored). Full suite re-run unchanged: 125/124/1/0.

## Step 14: node-level integration tests (2026-08-17)

Added `node-red-node-test-helper` (`^0.3.6`) as a devDependency of
`packages/node-red-agents`. Added one integration spec per node under
`nodes/<name>/test/integration/`, each loading the *real* node module into
a real Node-RED runtime (`helper.startServer/load/getNode/unload`) and
driving it through an actual `inject -> node -> helper("output")` flow --
exercising `RED.nodes.createNode`/`registerType`/`node.on('input', ...)`
wiring that the existing hand-rolled-fake-RED unit tests (`gh`'s
`test/fake-red.js`) or direct `lib/` function calls (`agent`,
`agent-server`) cannot reach:

- `nodes/gh/test/integration/gh.node-helper.spec.js` -- reuses the
  existing `test/fixtures/gh` stub (prepended to `PATH`), asserts on the
  real message a `pr list` invocation produces.
- `nodes/agent-server/test/integration/agent-server.node-helper.spec.js`
  -- uses the `status` operation with no `sessionID` (purely local
  registry aggregate, no daemon spawn needed), asserting on the real
  `{ total, busy, idle, sessions }` shape returned through the real input
  handler (an assertion mismatch during a first run -- missing
  `sessions: []` -- caught a real, previously-undocumented field of that
  shape; fixed the assertion, not the code).
- `nodes/agent/test/integration/agent.node-helper.spec.js` -- adds
  `nodes/agent/test/fixtures/opencode`, a fixed single-JSONL-event stand-in
  for the real CLI (prepended to `PATH`), asserting on the real resolved
  `payload`/`sessionID`/`agentExecution.status` fields.

All three passed their core structural assertions on the first run (only
the `agent-server` spec's expected-shape assertion needed one correction,
made against the runtime's actual output, not the other way around).

Verified `npm pack --dry-run` still produces exactly 33 files (test/ and
fixtures/ correctly excluded at every new depth, including
`nodes/agent/test/fixtures/` and `nodes/agent-server/fixtures/`). Full
suite: 128 tests, 127 pass, 1 skip, 0 fail (was 125/124/1/0; +3 for the
three new integration specs).

## Step 15: smoke/E2E harness (2026-08-17)

Extracted `scripts/run-and-watch.js`'s subscribe/inject/wait logic into
`scripts/lib/watch-debug.js` (`waitForDebug({ baseUrl, injectId, debugId,
maxWaitMs })`, resolving rather than exiting the process so it's reusable
from a test), leaving `run-and-watch.js` as a thin CLI wrapper.
Re-verified the CLI unchanged, against the real `demo/` instance (`make
demo`), including its red-status-detection path (`gh pr list` against a
repo it couldn't reach), before touching anything else.

Added `test/integration/`:
- `lib/node-red-instance.js` -- boots a real, throwaway `node-red` child
  process against a fresh temp userDir per run (never `data/` or
  `demo/`), symlinking only `node-red-agents` into a fresh
  `node_modules/` (see bug below), and exposes `deployFlow()` (real
  `POST /flows`) and `stop()` (kills the process, removes the temp dir).
- `flows/{gh,agent,agent-server}-smoke.json` -- one minimal
  `inject -> node -> debug` flow per node.
- `smoke.spec.js` -- for each flow: deploy it, then reuse
  `waitForDebug` to assert a real debug message arrived with no red
  status (and, for `agent-server`, the exact registry-summary payload).
- `Makefile`: `test-e2e` target (deliberately separate from `test`/CI's
  default gate, since `gh` and `agent` shell out to the real, installed
  `gh`/`opencode` CLIs -- no fakes here, unlike step 14's node-helper
  tests).

Two real bugs found and fixed while getting this working (not
hypothetical -- both reproduced, diagnosed, and fixed against actual
failures):
1. Symlinking the *entire* root `node_modules/` into the temp userDir
   made `node-red` itself fail to start (`ELOOP: too many symbolic
   links`). Fixed by symlinking only the single `node-red-agents` entry.
2. All three smoke flows initially timed out with zero debug output --
   including `agent-server`'s, which needs no external process at all,
   ruling out a CLI/timing issue. Root-caused via Node-RED's own
   `@node-red/runtime/lib/flows/util.js`: a node is only treated as a
   normal flow node (vs. a "config node", which never runs) if it has
   both `x` and `y` properties -- my flow fixtures had neither. Manifested
   as `Error: Circular config node dependency detected: <debug-node-id>`
   in the child process's own log (only visible once stderr was actually
   captured/inspected, not from the HTTP/WS side). Fixed by adding `x`/`y`
   to every non-tab node in all three fixtures.

Verified end-to-end via `make test-e2e`: all 3 smoke tests pass using the
real `gh` and `opencode` CLIs (gh: ~3.7s, agent: ~27s, agent-server:
~0.4s), no leftover temp directories or processes afterward. Confirmed
`make test` (the offline, CI-facing default gate) is completely
unaffected: still 128/127/1/0.

## Milestone C findings (2026-08-17)

Adversarial subagent review of the full test pyramid (steps 14-15),
independently reproducing every claim: all three node-level integration
specs genuinely use `node-red-node-test-helper`'s real runtime (no
hand-rolled fake RED, no `child_process`/`lib/` mocking -- CLI faking is
via real executable PATH fixtures only); PATH is saved/restored in
`before`/`after` in both specs that mutate it, with zero leak risk; `npm
test` reproduced at exactly 128/127/1/0; every non-tab fixture node
confirmed to have `x`/`y`; the `node-red-instance.js` symlink confirmed
scoped to only `node-red-agents`; `make test-e2e` re-run independently,
passing 3/3 against the real `gh`/`opencode` CLIs with no leftover temp
dirs or processes; confirmed `test-e2e` is a Makefile-only target never
reachable from any `package.json` test script (the offline/E2E
separation is structurally real, not just documented); `run-and-watch.js`
CLI contract (argv, exit codes, stdout/stderr format) confirmed
unchanged; the `agent-server` smoke/integration assertion's `{ total,
busy, idle, sessions }` shape confirmed to match `lib/registry.js`'s
actual `summary()` implementation, not fabricated. No issues found -- no
correction pass needed for this milestone.

## Step 18: final manual spot-check (2026-08-17)

Ran `make demo` against a fresh instance and used `scripts/run-and-watch.js`
by hand (not automated) against real inject/debug pairs on the actual
demo flow content:

- Playground tab's prompt inject -> Parallel Agents (SRT runtime) ->
  Final Output debug: on a first pass (before `srt` was installed in
  this environment) correctly reported a red status on that node, as
  expected per the README's documented optional prerequisite. After
  `srt` was installed, a clean re-run (fresh instance, to avoid a
  stale-status false-positive from `status/#`'s "send current status on
  subscribe" behavior -- a pre-existing characteristic of the shared
  watch logic, not new) produced a real `RESULT:` with no red status --
  the SRT-sandboxed agent execution completed successfully end-to-end
  through the refactored `packages/node-red-agents` -> `demo/` workspace
  link.
- `gh-issues-inject` -> `gh-issues-debug`: real `gh` CLI invoked
  end-to-end; result was a real (environment-specific, expected) `exit 1`
  against a repo not accessible with local `gh` auth -- confirms the
  pipeline itself (deploy, inject, WS status/debug capture) works
  correctly; the specific repo's accessibility is demo content, not part
  of this refactor's scope.

Confirmed throughout: `data/flows.json` never touched (git status shows
zero diff on it across the entire refactor), and every `make demo`/
`make demo-stop` cycle cleanly started and stopped its process group with
no orphans.

One unrelated finding surfaced by this step: after `srt` was installed
in this session, `npm test` went from 128/127/1/0 to 128/127/0/1 (a fail,
not a skip) -- `nodes/agent/test/runtimes/srt.spec.js`'s one `srt`-gated
test (`skip: !hasSrt()`) now runs instead of skipping, and fails with
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` -- a
bubblewrap/sandbox networking-permission limitation of this container,
not a regression: `git diff` confirms this test file is byte-identical
to its pre-refactor original (only its path changed, in step 3's move).
Out of scope for this refactor; noted for the record, not corrected.

## Refactor complete

All 18 planned steps (see step-by-step plan above) and all three
adversarial-review milestones (A, B, C) are done, each with corrections
verified where findings occurred (Milestone A only) and clean bills of
health otherwise (Milestones B, C). `packages/node-red-agents` is a
single, publishable, workspace-managed npm package with a real
50/30/20-shaped test pyramid (125 unit + node-level-integration tests
plus 3 real smoke/E2E tests, run separately per `AGENTS.md`'s testing
philosophy), a working scaffolder, a decoupled demo flow, and no
remaining references to the pre-refactor `custom-nodes/` layout.

## Non-goals

- Not splitting `agent`/`agent-server`/`gh` into separately published
  npm packages.
- Not scripting the demo-flow extraction from `data/flows.json` — it's
  hand-curated content, not mechanical.
- Not changing node runtime behavior/logic during the move steps --
  moves are structural only; behavior changes (if any) happen in
  clearly separated commits.

## Amendment (2026-08-18): scoped npm package name + keywords

Everything above records the plan and evidence as it happened, under
the package's original unscoped name (`node-red-agents`). Follow-up
findings after the refactor changed that name -- recorded here rather
than edited into the history above:

- Node-RED's own packaging docs (updated 31 Jan 2022) require new
  packages to use a **scoped** name (`@myScope/node-red-...`), not the
  legacy unscoped `node-red-contrib-*` convention. The originally-chosen
  `node-red-agents` was neither convention.
- Renamed `packages/node-red-agents/package.json`'s `name` to
  `@tbrandenburg/node-red-agents` (verified unclaimed on the npm
  registry via `npm view`, alongside the unscoped alternatives
  `node-red-agents` and `node-red-contrib-agents` -- all three were
  available, but only the scoped one matches current guidance). Added
  `publishConfig.access: "public"` (required for a scoped package to
  publish as public rather than npm's paid-private default).
- Expanded `keywords` (compared against real, currently-published
  Node-RED packages -- `node-red-contrib-knx-ultimate`,
  `node-red-contrib-telegrambot`, `node-red-contrib-openai`, etc. --
  which all key on specific tool/tech names, not generic single words)
  to add the previously-missing `gh`, `github-cli`, `pi` (the second
  supported agent adapter), `sandbox`, `srt`, `coding-agent`, `ai-agent`.
- Updated every place that referenced the bare `node-red-agents` name
  as an actual npm dependency specifier: `data/package.json`,
  `demo/package.json`, and `test/integration/lib/node-red-instance.js`
  (which now creates a `node_modules/@tbrandenburg/` scope directory
  before symlinking, since scoped packages nest one level deeper).
  Regenerated `data/`, `demo/`, and root lockfiles via `npm install`.
- Verified: root `npm test` unaffected (128/127/1/0, the 1 fail being
  the pre-existing, unrelated `srt` sandbox-permission issue); `make
  demo` boots cleanly with all 190 nodes loaded via the renamed,
  workspace-linked package; `npm pack --dry-run` still produces exactly
  33 files, now under the tarball name
  `@tbrandenburg/node-red-agents@0.1.0`.
- Left the git tag naming scheme in `make release`/`make publish`
  (`node-red-agents@<version>`) unscoped by design -- it's this repo's
  own release-tag convention, independent of the npm package's exact
  name, and reads more cleanly as a git ref without a nested `@`/`/`.
- Confirmed: this repo publishes exactly **one** npm package. The
  `custom-nodes/` directory (which would have held separately-published
  packages) no longer exists at all (deleted in step 10) -- `agent`,
  `agent-server`, and `gh` are only ever published together as the one
  scoped package.

