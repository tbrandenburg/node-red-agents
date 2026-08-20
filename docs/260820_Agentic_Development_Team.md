# Agentic Development Team — demo flow plan

Status: **plan / for review** (nothing implemented yet)
Date: 2026-08-20
Target: new tab + dashboard page in `demo/flows.json` (demo instance, port 1881)

---

## 1. Goal

A fourth showcase tab, **Agentic Development Team**, that continuously watches a
GitHub repository and keeps up to 3 agents per category busy on its open issues,
open pull requests and recent Actions runs — with a start/stop schedule, live
per-item state tables, and a chronological agent-event trace.

Everything runs **read-only against the remote**: agents work exclusively in
local, per-task git worktrees, and their output is deliberately thrown away.
This is a demonstration of orchestration, not a production automation.

## 2. Constraints discovered in the existing code

These drive most of the design decisions below.

1. **`scripts/ensure-repo.sh` is not safe for concurrent agents.** It maintains
   *one* clone per repo (`workspace/<owner>__<repo>`) and runs
   `fetch && checkout && reset --hard && clean -fd` on every invocation. The
   `arw-repo-gate` lock inside `arw-subflow` serialises only the clone step, not
   the agent run. Nine concurrent agents sharing that directory would corrupt
   each other's work. → per-task worktrees are mandatory (§4).
2. **The existing prompts assume the agent creates its own worktree.**
   `prompts/fix-issue.md` instructs `git worktree add …`, and
   `prompts/investigate-issue.md` ends with `gh issue comment` — a remote write.
   → a new, separate prompt set is required (§5).
3. **`arw-subflow` cannot be interrupted.** It has no terminate path to its
   internal `agent` node, and its outputs don't expose an `executionId` at
   dispatch time. Retrofitting both would risk regressing the Issue Control
   Center. → a new, ADT-specific subflow instead (§6).
4. **The `agent` node (0.2.0) already provides what we need:** a per-run
   `executionId` on output 2's event envelope (`msg.executionId`) and on
   output 1 (`msg.agentExecution.id`), plus a terminate input
   (`msg.operation = "terminate"` + `msg.executionId`, addressed to the *same*
   node instance). `msg.agentId` is the node id — constant across concurrent
   runs of one node — so the tables key on `executionId`.

## 3. Dashboard layout

New `ui-page` **Agentic Development Team**, path `/adt`, grid layout, 12 columns,
attached to the existing `My Dashboard` ui-base and default theme.

```
+----------------------------------------------------------+
| Repo Settings  [Host][Owner][Repo][Model] [Update][▶][■]  |  w12 h1
+----------------------------------------------------------+
+---------------+ +----------------+ +---------------------+
| Issues        | | Pull Requests  | | Actions             |  w4 each
| [max: 3]      | | [max: 3]       | | [max: 3]            |
| <table>       | | <table>        | | <table>             |
+---------------+ +----------------+ +---------------------+
+----------------------------------------------------------+
| Stats and Logs                                            |  w12
| Active workflows: <count>                                 |
| Agent Events (newest first, capped at 50)                 |
+----------------------------------------------------------+
```

Widgets:

| Group | Widgets |
|---|---|
| Repo Settings | `ui-text-input` Host (hint `github.com`), Owner (hint `octocat`), Repository (hint `hello-world`); `ui-dropdown` Model (default `github-copilot/gpt-5.6-luna`); `ui-button` Update / Start / Stop |
| Issues | `ui-number-input` "Max concurrency" (default 3); `ui-table` |
| Pull Requests | same, own table |
| Actions | same, own table |
| Stats and Logs (renamed from "Agent Events") | `ui-text` "Active workflows" (live count of `in_progress` tasks across all kinds, `order: 1`); `ui-table` Agent Events (`order: 2`) |

Defaults are seeded on deploy by an `inject` with `once: true` so the tables and
context are populated before any user interaction (same trick the other demo
tabs use for their initial state).

## 4. Workspace isolation (outcome, not mechanism)

**Required outcome:** every agent run starts in its own, already-prepared git
worktree of the target repo, checked out on the default branch, isolated from
every other concurrent run; the agent never has to create or reason about
worktrees itself.

**Chosen mechanism:** a new `scripts/ensure-worktree.sh <host> <owner> <repo>
<taskKey>`, kept deliberately small:

- maintains one shared **base clone** at `workspace/<owner>__<repo>.base`
  (`clone` if absent, then `fetch origin`) — the only step needing the existing
  per-repo lock;
- derives the default branch the same way `ensure-repo.sh` does;
- creates (or reuses) a worktree at
  `workspace/<owner>__<repo>--<taskKey>` on a task branch
  `adt/<taskKey>` based on `origin/<defaultBranch>`;
- **idempotent**: if the worktree directory already exists and is a valid
  worktree, it is reset to `origin/<defaultBranch>` and cleaned rather than
  recreated — so a task that was hard-stopped and later retried under the same
  `taskKey` just works;
- prints `REPO_DIR=` / `DEFAULT_BRANCH=` exactly like `ensure-repo.sh`, so the
  downstream parsing logic is unchanged.

`taskKey` is deterministic per task and phase:
`issue-<n>`, `issue-<n>-fix`, `pr-<n>`, `run-<id>`.

**Lifecycle:** worktrees are *not* removed when a task ends. They are pruned at
the beginning of every **Start**: `scripts/prune-worktrees.sh <owner> <repo>`
removes every `workspace/<owner>__<repo>--*` directory and runs
`git worktree prune` in the base clone. This keeps results inspectable between
runs and bounds disk growth to one schedule cycle.

`ensure-repo.sh` and the Issue Control Center are left untouched.

## 5. Prompts — `prompts/read-only/`

Four new files. All of them:

- state that the agent is **already inside an isolated worktree** at the current
  directory, and must **not** create worktrees, switch branches, commit, push,
  or open/comment on anything;
- restrict `gh` usage to read-only subcommands (`view`, `diff`, `list`,
  `run view --log`);
- ask for the result to be **printed to stdout** (it is captured as the agent's
  payload and shown in the trace), never written to the remote;
- keep the analysis intentionally shallow/cheap — this is a showcase.

| File | Used by | Placeholders |
|---|---|---|
| `investigate-issue.md` | Issues, phase 1 | `{{repoSlug}}`, `{{defaultBranch}}`, `{{issueNumber}}` |
| `fix-issue.md` | Issues, phase 2 | same |
| `review-pr.md` | Pull Requests | `{{prNumber}}` |
| `investigate-action.md` | Actions | `{{runId}}`, `{{workflowName}}`, `{{conclusion}}` |

Note on `fix-issue.md`: because each subflow run gets a fresh worktree, the fix
phase cannot inherit the investigation's context. The prompt therefore
re-establishes context itself (`gh issue view`) and then edits files **locally
only**, summarising the resulting diff (`git diff`) on stdout. Nothing is
committed. The table state is labelled simply **Fixed** — no PR is created.

Loaded via `file in` nodes with paths relative to the repo root
(`prompts/read-only/…`), matching the existing Issue Control Center convention.

## 6. New subflow: `adt-task-subflow`

Rather than extending `arw-subflow` (regression risk for the Issue Control
Center, and it lacks a terminate path), ADT gets its own small subflow —
one definition, **four instances**: Issue Investigate, Issue Fix, PR Review,
Action Investigate.

**Input msg:** `{ context, promptTemplate }` where
`context = {host, owner, repo, model, kind, itemId, taskKey, phase}`.

**Internal path:**

```
in ─▶ [switch: operation]
        ├ terminate ──────────────────────────────────▶ (agent node, terminate input)
        └ normal ─▶ [build args] ─▶ [exec ensure-worktree.sh]
                    ─▶ [handle result: parse REPO_DIR/DEFAULT_BRANCH]
                    ─▶ [GATE: schedule still running?]     ← the only abort point
                    ─▶ [render prompt template]
                    ─▶ [agent] ─▶ [handle result]
```

**Outputs:**

1. **completion** — `{context, status, payload}` (success or failure); drives the
   phase transition and frees the concurrency slot.
2. **agent events** — the `agent` node's output 2, verbatim; drives the Agent
   column (first `running` event carries the `executionId`) and the trace table.
3. **log/error rows** — worktree failures, gate aborts, prompt-render problems.

**The gate** is the whole of the stop-during-setup story, and is deliberately the
simplest thing that satisfies the priority *"the agent must not be started"*: a
one-line function node immediately before the `agent` node that drops the message
if `global.adt_running` is false. Nothing else in the pipeline is interruptible —
a `git fetch` may finish after Stop was pressed, which costs a second and zero
tokens. No generation counters, no cancellation plumbing.

## 7. State model

All in **global** context (not `flow`): the `adt-task-subflow` instances have
their own private flow context, separate from the tab's, so anything the gate
or dispatch logic needs to see from both places must be global. (Discovered
during M3 verification — the plan originally said `flow.adt_*`.)

```js
global.adt_ctx     = { host, owner, repo, model }
global.adt_running = false                       // schedule on/off
global.adt_max     = { issue: 3, pr: 3, action: 3 }
global.adt_tasks   = {
  issue:  { "42": { id, title, phase, executionId, updatedAt }, … },
  pr:     { "17": { … } },
  action: { "99123": { …, workflowName, conclusion } },
}
```

Phases and their table glyphs:

| kind | phases |
|---|---|
| issue | ⬜ not_started → ⏳ in_progress *(investigate)* → ⏳ in_progress *(fix)* → 🔧 fixed; 🔒 closed |
| pr | ⬜ not_started → ⏳ in_progress → 👀 reviewed; 🔒 closed/merged |
| action | ⬜ not_started → ⏳ in_progress → 🔍 investigated |

Investigation of issues surfaces as 🔍 only transiently — the chain moves
straight on to the fix phase, occupying the *same* concurrency slot throughout
(one slot per issue for both phases, as agreed).

Table columns per group: `State | # | Title | Agent`, where **Agent** shows the
run's `executionId` (short form) while in progress, and is cleared on completion.

## 8. Control flow

### Refresh (Update button, and every tick while running)

Three `gh` calls in parallel:

| kind | command |
|---|---|
| issue | `gh issue list --state open --limit 20 --json number,title,state` |
| pr | `gh pr list --state open --limit 20 --json number,title,state` |
| action | `gh run list --limit 20 --json databaseId,name,status,conclusion` |

Each feeds a **reconcile** function node that merges the fresh list into
`global.adt_tasks[kind]`, **preserving existing phases and executionIds**:

- id not yet tracked → `not_started`;
- tracked id no longer in the open list → `closed` (issues/PRs only);
- everything else keeps its phase.

Actions are investigated **regardless of conclusion** — green runs for
continuous-improvement suggestions, red runs for failure analysis — and have no
`closed` phase.

Reconcile then re-renders that group's table and hands off to dispatch.

### Schedule

A single `inject` with `repeat: 30`, whose first node returns `null` unless
`global.adt_running` is true.

- **Start** → prune worktrees, set `global.adt_running = true`, fire one immediate
  tick.
- **Stop** → set `global.adt_running = false`, then sweep: for every task with an
  `executionId`, emit `{operation:"terminate", executionId, kind}` routed by a
  `switch` on `kind` into the matching subflow instance. Terminated tasks are
  reset to ⬜ *not_started* and their Agent cell cleared, so the next Start
  retries them against the same (idempotent) `taskKey`. The sweep is scoped to
  ADT-tracked executionIds only — Issue Control Center and Chat agents are
  untouched.

### Dispatch

Per group, after each reconcile: count `in_progress`; while
`count < global.adt_max[kind]`, take the next `not_started` item, mark it
`in_progress`, and send it into that group's subflow instance with the
corresponding prompt template. Issue completions of the *investigate* phase
re-enter dispatch as an immediate *fix* dispatch for the same issue (slot never
released in between). Errors from output 3 clear the slot too, so a failure
cannot permanently wedge the concurrency counter.

### Traces

Subflow output 2 from all four instances → one flatten function (reusing the
Issue Control Center's `icc-flatten-agent-log` shape) → prepend to a
`global.adt_trace` array capped at **50** rows, newest first → `ui-table`.

## 9. Files touched

| Path | Change |
|---|---|
| `demo/flows.json` | + tab, + ui-page/groups, + `adt-task-subflow`, + 4 instances |
| `prompts/read-only/*.md` | new (4 files) |
| `scripts/ensure-worktree.sh` | new |
| `scripts/prune-worktrees.sh` | new |
| `scripts/check-flows.js` | new (flow referential-integrity checker) |
| `docs/260820_Agentic_Development_Team.md` | this plan |
| `README.md` | one line in the demo section |

Nothing under `packages/node-red-agents/` changes — the 0.2.0 node API is
sufficient. `data/flows.json`, `arw-subflow`, `scripts/ensure-repo.sh` and the
existing `prompts/*.md` are untouched.

## 10. Phased implementation and verification

Seven milestones. Each one ends in a state that is independently verifiable and
leaves the demo instance working; none of them requires the next one to exist.
No milestone is declared done without the listed evidence actually captured.

**Standing gates, re-run at the end of every milestone that touches files:**

- `python3 -m json.tool demo/flows.json` — the flow file is still valid JSON.
- `scripts/check-flows.js` (new, ~30 lines, M0) — referential integrity of
  `demo/flows.json`: every `wires` target exists, every `z` points at a real
  tab/subflow, every `group`/`page`/`ui` reference resolves, no duplicate node
  ids, every subflow instance's `type` matches a defined subflow. This is the
  cheapest way to catch the wiring/routing pitfalls that are otherwise only
  found by a red deploy.
- `make format FIX=1 && make lint` — repo style gates.
- `make test` — must stay green (regression check; the package is untouched).
- `curl -X POST -H 'Content-Type: application/json' --data @demo/flows.json
  http://127.0.0.1:1881/flows` → **204**. A non-204, or a "circular config
  node"/"unknown type" error in the demo log, fails the milestone.

---

### M0 — Harness and safety net

Build `scripts/check-flows.js` and run it against the **current, unmodified**
`demo/flows.json` first.

*Exit criteria:* the checker reports zero problems on today's flow file (proving
the checker itself is not producing false positives), and `make demo` boots with
the untouched flow, `POST /flows` → 204.
*Method:* code inspection + script run + admin API.
*Risk retired:* every later milestone gets instant, cheap wiring validation.

### M1 — Workspace isolation, outside Node-RED

`scripts/ensure-worktree.sh` and `scripts/prune-worktrees.sh` only. Verified
purely from the shell — no flow involvement.

*Exit criteria:*
- `ensure-worktree.sh github.com tbrandenburg node-red-agents issue-1` creates
  `workspace/tbrandenburg__node-red-agents--issue-1` on `adt/issue-1` and prints
  `REPO_DIR=` / `DEFAULT_BRANCH=`;
- running it **again** with the same key succeeds and yields a clean tree
  (idempotence — the hard-stop retry path);
- three different keys run **concurrently** (`&` + `wait`) and each ends with an
  independent, non-corrupted worktree — the failure mode §2.1 describes;
- an invalid `owner` is rejected, as in `ensure-repo.sh`;
- `prune-worktrees.sh` removes all `--*` worktrees and leaves the base clone.

*Method:* shell transcript, `git worktree list`, `git -C … status`.
*Risk retired:* the single biggest correctness risk in the whole feature.

### M2 — Prompts, exercised directly

The four `prompts/read-only/*.md` files, run through the real `opencode` CLI by
hand inside an M1 worktree — not through Node-RED.

*Exit criteria:* each prompt returns a plausible answer on stdout, and
afterwards the worktree shows **no** commits (`git log origin/<default>..HEAD`
empty), no pushed branch, and the target repo shows no new comment. Placeholder
set matches exactly what §5 documents (checked by grepping `{{…}}` against the
context fields the flow will supply).
*Method:* manual CLI run + `git` inspection + `gh issue view`.
*Risk retired:* the read-only guarantee, which §11 says is currently carried by
prompt wording alone.

### M3 — `adt-task-subflow`, driven by an inject

The subflow plus **one** instance (Issue Investigate), a `Test:` inject that
feeds it a hardcoded context, and a debug node on each output. No UI, no
scheduler, no tables.

*Exit criteria:* `node scripts/run-and-watch.js <injectId> <debugId>` returns a
completed agent result; output 2 carries an `executionId` on the first `running`
event; setting `global.adt_running=false` via a second inject makes the gate drop
the dispatch **before** any agent starts (verified by the absence of any agent
event on `/comms`, not just by the debug output).
*Method:* `run-and-watch.js` + a `/comms` subscription.
*Risk retired:* subflow wiring, output routing, and the entire stop-before-start
mechanism.

### M4 — Terminate path

Add the `operation: terminate` branch and the `switch` on `kind`, still driven by
injects.

*Exit criteria:* a long-running agent started in M3 is killed by an injected
terminate carrying its `executionId`; `/comms` shows a `failed`/`cancelled`
lifecycle event and the child process is gone (`ps` on the captured pid, per
`AGENTS.md` — no broad `pkill`). A terminate for an unknown `executionId`
produces a caught error, not a stuck flow.
*Method:* `run-and-watch.js`, `/comms`, `ps`.
*Risk retired:* the hard-stop requirement, which is the one behaviour that costs
real tokens when broken.

### M5 — State, reconcile, dispatch, tables

The three `gh` list branches, reconcile/dispatch function nodes, `global.adt_tasks`,
the three tables, the trace table, and the remaining three subflow instances —
but with the schedule driven by injects rather than UI buttons.

*Exit criteria (acceptance criteria 1–3 and 5):*
- inject "Update" → all three tables populate from real `gh` output;
- with `adt_running` true, a manual tick starts **exactly** `max` agents per
  group and no more; lowering `max` mid-run is honoured on the next tick;
- issue rows progress ⬜ → ⏳ → ⏳(fix) → 🔧 and hold **one** slot throughout;
- an induced failure (bad prompt path) frees the slot instead of wedging it;
- the trace table fills and stays at ≤50 rows.
*Method:* `run-and-watch.js` per inject; `global.adt_tasks` dumped by a
`Test: dump state` inject + debug node (the pattern
`icc-test-dump-logs` already uses).
*Note:* before writing the `gh run list` node, verify the JSON field names
against the installed CLI (`gh run list --json` with no value lists them) — §11
flags this as unverified.

### M6 — UI wiring and full round trip

Repo Settings inputs, Model dropdown, Update/Start/Stop buttons, concurrency
number inputs, page/group layout.

*Exit criteria (all acceptance criteria, end to end):* on
`http://localhost:1881/dashboard/adt` against
`github.com / tbrandenburg / node-red-agents` — Update populates; Start refreshes
every 30s (timestamps in the trace prove the interval) and dispatches up to 3+3+3
agents showing their `executionId`; Stop starts nothing new **and** terminates
running agents, whose rows return to ⬜; a subsequent Start re-runs them via the
idempotent `taskKey`; the trace holds the newest 50 events.
Final read-only audit: no agent-authored comments on the repo, no pushed `adt/*`
branches (`git -C workspace/…base branch -r`).
*Method:* browser for the layout only; everything behavioural through
`run-and-watch.js` / `/comms`, per `AGENTS.md`'s "react, don't sleep-and-poll".
*Fallback:* if `ui-number-input` is unavailable in the installed Dashboard 2.0,
substitute `ui-text-input` + parse-and-clamp function — a UI-fidelity sacrifice
that keeps the behaviour identical.

---

If a milestone cannot be completed as specified, it is reported as **BROKEN**
with the failing evidence rather than worked around silently, and the plan is
amended before continuing.
4. Manual check that no remote mutation happened: `gh issue view` /
   `gh pr view` on the target repo shows no agent-authored comments, and
   `git -C workspace/<…>.base branch -r` shows no pushed `adt/*` branches.

## 11. Deliberate non-goals

- No PR creation, no commits, no issue comments.
- No persistence of state across a Node-RED restart (flow context is in-memory).
- No mid-setup cancellation beyond the single pre-agent gate.
- Agent outputs are not stored anywhere but the trace table.

## 11a. SRT sandbox (enabled 2026-08-20)

The `adt-run-agent` node (the single "Run Agent" node inside `adt-task-subflow`,
shared by all four instances) now runs with `runtime: srt` instead of `direct`,
turning the read-only guarantee from "carried by prompt wording alone" (§11's
original wording) into enforcement: `gh`/`opencode` inside the sandbox
physically cannot reach any network host outside the allowlist or write outside
the allowlisted directories, regardless of what the prompt says or what the
model decides to try.

**`srtAllowedDomains: ["api.githubcopilot.com", "api.github.com"]`**

- `api.githubcopilot.com` — matches the convention already used by the other
  `github-copilot/gpt-5.6-luna` agent nodes (Parallel Agents, Sandboxed Agent);
  needed for the model API calls themselves.
- `api.github.com` — proven necessary and *sufficient* by running every `gh`
  subcommand the four read-only prompts actually issue
  (`gh issue view`, `gh issue list`, `gh pr view`/`gh pr diff`, `gh run list`,
  `gh run view --log`) against `tbrandenburg/node-red-agents` with
  `GH_DEBUG=api`: every one of them made requests to `api.github.com` only —
  no `github.com`, `objects.githubusercontent.com`, `uploads.github.com`, or
  any other GitHub host was ever contacted, including for `run view --log`
  (this gh version, 2.45.0, serves log content through the same
  `api.github.com` job/run endpoints rather than a separate blob-storage
  redirect). Confirmed empirically inside `srt` too: with only
  `api.githubcopilot.com` allowed, `gh issue list ...` failed with
  `Post "https://api.github.com/graphql": Forbidden` (proving the allowlist is
  enforced, not a no-op); adding `api.github.com` made the identical call
  succeed.
- A pre-existing, unrelated wrinkle surfaced during this: `gh`'s own OS-keyring
  based auth (`gh auth status` reports "(keyring)") does not work inside the
  bubblewrap sandbox (no dbus/secret-service socket bound in), so `gh` reports
  "token ... is invalid" even with the right domain allowed. This is not a
  network-allowlist problem — passing `GH_TOKEN` (`gh auth token`) through the
  environment bypasses the keyring path entirely and works identically inside
  and outside the sandbox. `make demo`/`make demo-stop` therefore need
  `GH_TOKEN` in the environment when SRT is in use on a host relying on keyring
  auth; this is an environment/host concern, not a flow or node-package change.

**`srtAllowedWriteDirs: [".", "/tmp", "~/.local/share/opencode"]`** — unchanged
from the existing convention, each entry independently verified necessary:

- `.` — resolves relative to the spawned process's `cwd`, which
  `adt-run-agent`'s `cwd` binding sets to the current task's worktree
  (`workspace/<owner>__<repo>--<taskKey>`) on every run. Verified empirically:
  from inside one worktree, `srt -s <settings> -- touch inside-ok.txt`
  succeeded, while `touch ../escape-test.txt` (one directory up, i.e. the
  workspace root shared by sibling worktrees) failed with
  `Read-only file system` — proving `.` scopes write access to exactly that
  worktree, not its parent or siblings.
- `/tmp` — opencode's log directory fallback and other scratch use.
- `~/.local/share/opencode` — proven necessary by running `opencode run`
  inside `srt` *without* it allowlisted: it failed immediately with
  `Unknown: FileSystem.open (/home/tom/.local/share/opencode/log/opencode.log)`.
  Adding it back made the identical run succeed.

**Live verification** (`github.com/tbrandenburg/node-red-agents`, model
`github-copilot/gpt-5.6-luna`, real `srt`/`opencode`/`gh`): all four workflow
types — Issue Investigate, Issue Fix, PR Review (driven manually against PR
#11 since the repo had no open PRs at test time), and Action Investigate (3
concurrent runs against real Actions runs) — completed successfully with the
output-2 lifecycle envelope's `runtime` field reading `srt` throughout
(`running` → tool events → `completed`). `adt-issue-fix-instance`'s tool-call
events showed `workdir` pointing at its own
`...--issue-1-fix` worktree, and its `git status --short` afterwards showed
local, uncommitted edits (`package.json`,
`packages/node-red-agents/nodes/agent/test/runtimes/srt.spec.js`) confined to
that worktree only — the base clone and the sibling `--issue-1`
(investigate-phase) worktree both stayed clean. Deliberately removing
`api.github.com` from the allowlist for one run reproduced the `Forbidden`
network error from the domain-selection testing above, confirming the
enforcement is live in the actual flow, not just in isolated `srt` probes.
Final read-only audit after the run: `gh issue view 1 --json comments` → 0
comments, `gh pr view 11 --json comments` → 0 comments, `git ls-remote
--heads` on the real remote → 0 `adt/*` branches.

## 12. Implementation notes / deviations (M0–M6, filled in as built)

- **`global` not `flow` for all `adt_*` state** (§7): the plan originally said
  `flow.adt_*`; corrected during M3 because the `adt-task-subflow` instances
  have their own private flow context, invisible to the tab's flow and to each
  other. All state lives in `global` context instead.
- **`ui-number-input` is not available** in the installed Dashboard 2.0
  (`node-red-dashboard` — grepped every `"type": "ui-*"` across
  `demo/flows.json`; no `ui-number-input` node type exists anywhere in the
  file). M6 used the documented fallback: a `ui-text-input` per group ("Max
  concurrency (Issues|PRs|Actions)") feeding a small parse/clamp function
  (`parseInt`, clamped to `[1, 20]`, default `3` on invalid input) that sets
  `global.adt_max[kind]` — reactive on blur/enter, no separate submit button,
  matching the number-input's implied UX.
- **Repo Settings widgets have no native "hint"/placeholder property**: like
  the Issue Control Center's Host/Owner/Repository inputs, the hint is baked
  into the widget's `label` (e.g. "Host (e.g. github.com)") rather than a
  separate placeholder field, since Dashboard 2.0's `ui-text-input` doesn't
  expose one.
- **The "Issue Investigate" subflow instance is the M3 test-scaffolding node**
  (`adt-test-issue-investigate-instance`): it was wired into production
  dispatch/reconcile during M5 and left with its original id/name rather than
  duplicated, to avoid a second, functionally-identical instance. Its debug
  taps (`adt-test-debug-*`) and the M3/M4 `Test:` injects remain in the tab —
  same permanent-fixture convention the Issue Control Center already
  established for its own `Test:` injects.
- **Start**: implemented as `ui-button` → function (sets
  `global.adt_running = true`, builds `"<owner> <repo>"` payload) → `exec`
  node running `bash scripts/prune-worktrees.sh` (`addpay: true`, mirroring
  `arw-ensure-repo-exec`'s pattern) → the exec node's success output (1) wires
  directly into the same 6 targets as a combined Update+dispatch tick (the 3
  `gh`-list build functions and the 3 dispatch functions), so pruning
  completes before the first list/dispatch cycle of a fresh Start.
- **Stop**: implemented as a single 4-output function
  (`adt-stop-fn`/"sweep + terminate + reset (all kinds)"): sets
  `global.adt_running = false`, then for every tracked task (any kind) with a
  live `executionId` emits `{operation:'terminate', executionId}`, resets that
  task's phase to `not_started` and clears its `executionId` synchronously,
  and re-renders all three tables immediately. Because `issue` tasks share one
  concurrency slot across the investigate/fix phases without recording which
  subflow instance currently holds the run, a terminate for an `issue` task is
  broadcast to **both** the Issue Investigate and Issue Fix instances — an
  unmatched `executionId` produces the caught error M4 already verified is
  non-fatal, so this is safe.
- **Bug found and fixed during M6 live verification**:
  `adt-completion-action-investigate` (built in M5) unconditionally set an
  action's phase to `investigated` regardless of `msg.status`, on the
  (correct-looking but incomplete) reasoning that "both a passing and a
  failing Actions run are an informative terminal result". This silently
  raced with Stop: Stop's synchronous reset to `not_started` was overwritten
  moments later when the terminated run's (async) `failed` completion event
  arrived and re-set the phase back to `investigated`, breaking acceptance
  criterion 9d ("rows return to not_started"). Fixed to match the
  issue/PR completion functions' pattern: `phase = (status === 'completed') ?
  'investigated' : 'not_started'`. Verified live: before the fix, 3
  Stop-terminated actions stayed at `investigated`; after the fix, an
  identical Stop → all terminated actions correctly show `not_started`, and a
  subsequent Start re-dispatches them.
- **Scheduler**: a single `repeat: 30` `inject` → a one-line gate function
  (`if (!global.get('adt_running')) return null;`) → the same 6 targets as
  Start's immediate tick. Verified live over ~3 minutes: the trace table's
  timestamps advance roughly every 30s, dispatch keeps topping up completed
  slots to each kind's max, and the schedule stops cleanly on Stop with no
  new dispatch on the next tick.
- **Live round-trip verification** (`github.com/tbrandenburg/node-red-agents`,
  model `github-copilot/gpt-5.6-luna`, real `opencode`/`gh` CLIs, ~7 minutes
  total): Update populated 1 open issue, 0 open PRs, 20 recent Actions runs.
  Start pruned+recreated worktrees and immediately dispatched all *available*
  not_started items up to each kind's max (1 issue — only one existed — and 3
  actions; 3+3+3=9 concurrent is only reachable with ≥3 not_started items per
  kind, which this repo didn't have for issues/PRs at test time). The issue
  chain completed its investigate phase and correctly re-entered dispatch as
  a fix-phase run in a separate `--issue-1-fix` worktree, never touching the
  main clone. Stop terminated all live runs (`SIGTERM`, confirmed in the
  Node-RED log) and reset every terminated row to `not_started`; a subsequent
  Start re-dispatched them against the same, reused (idempotent) worktrees.
  The trace table held exactly 50 rows, newest first, throughout. Final
  read-only audit: `gh issue view 1 --json comments` → empty; `git ls-remote
  --heads` on the real remote → no `adt/*` branches.
- **SRT enablement (2026-08-20)**: switching `runtime: direct` → `runtime: srt`
  on `adt-run-agent` required no code changes (see §11a for the full
  domain/write-dir rationale). Two surprises worth recording: (1) `gh`'s
  keyring-based auth doesn't survive the bubblewrap sandbox — needs `GH_TOKEN`
  in the environment as a fallback, unrelated to the network allowlist itself;
  (2) no extra GitHub domain beyond `api.github.com` was needed even for
  `gh run view --log` — this gh version (2.45.0) serves log content through
  the same REST endpoints rather than redirecting to a separate blob-storage
  host, so the allowlist could stay minimal. No noticeable timing difference
  between `direct` and `srt` runs was observed — `srt`'s bubblewrap overhead
  was dwarfed by the model/tool round-trip latency of the actual `opencode`
  runs (each investigate/fix/review run took 1-3 minutes regardless of
  runtime).
- **"Active workflows" live counter (2026-08-20)**: the trace group
  (`adt-ui-group-trace`) was renamed from "Agent Events" to "Stats and Logs"
  (the `ui-table` node itself keeps its own "Agent Events" name/label, so the
  table's own heading is unaffected), and a new `ui-text` widget ("Active
  workflows", `order: 1`) was added above the existing trace table (bumped to
  `order: 2`) to show a live count of tasks currently `in_progress` across all
  three kinds. A new function node, `adt-compute-active-count`, recomputes the
  count from `global.adt_tasks` on every call (ignoring `msg` entirely, so it
  tolerates the `null`/empty messages some of its triggers emit) and feeds the
  text widget. It is wired as an *additional* output from 11 existing nodes
  that are the only places phase actually changes: the three reconcile
  functions (paints the count right after Update, before any dispatch), the
  three dispatch functions (`not_started` → `in_progress`), the four
  completion handlers (`in_progress` → terminal/failure), and `adt-stop-fn`'s
  table-render output (bulk reset to `not_started`). No existing wire was
  removed or reordered. Verified live: Update alone shows "Active workflows:
  0"; a Start + dispatch tick against the real repo showed "Active workflows:
  4" (1 issue + 3 actions dispatched, matching a `Test: dump state` count of
  `in_progress` rows exactly). The chained-issue-slot case (§7: investigate →
  fix keeps the *same* slot occupied throughout) was confirmed by code
  inspection: `adt-completion-issue-investigate`'s success branch never
  touches `phase` (it stays `in_progress`), so the count does not drop between
  the investigate-complete and fix-dispatch events for a chained issue --
  consistent with a ~3-minute live observation window where the count held
  steady at 4 across several scheduler ticks while an issue task's
  `executionId` changed underneath it (investigate retrying after a real, but
  unrelated to this change, network-allowlist rejection from the configured
  model). Stop-driven reset to 0 was verified by forcing `adt_tasks` back to
  all-`not_started` (the same state a fully-executionId-tracked Stop sweep
  produces) and confirming the counter dropped to "Active workflows: 0"; a
  pre-existing edge case was also surfaced during this verification and is
  called out separately below since it predates and is unrelated to the
  counter itself.
- **Pre-existing edge case found during counter verification (not fixed, out
  of scope for the counter change)**: `adt-stop-fn`'s sweep only resets a
  task's phase if it already has a live `executionId` (`if (t.executionId)`).
  A task that was dispatched (`phase = 'in_progress'`) but whose agent failed
  before its output-2 `running` event ever arrived (so the
  running-event-sync function in §6 never got to backfill `executionId`) is
  invisible to the sweep and stays `in_progress` forever, even across
  repeated Stops -- observed live when three Actions runs hit the same
  network-allowlist rejection immediately on start. This is a latent bug in
  the existing Stop implementation, unrelated to and not introduced by the
  "Active workflows" counter (which faithfully reports whatever
  `global.adt_tasks` says); flagged here for a future fix rather than
  silently worked around.

