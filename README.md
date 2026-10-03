# node-red-agents

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)
[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](.nvmrc)
[![Node-RED >=4.0.0](https://img.shields.io/badge/node--red-%3E%3D4.0.0-8f0000?logo=nodered&logoColor=white)](https://nodered.org)
[![npm package](https://img.shields.io/badge/npm-%40tbrandenburg%2Fnode--red--agents-cb3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/@tbrandenburg/node-red-agents)
[![Tests](https://github.com/tbrandenburg/node-red-agents/actions/workflows/tests.yml/badge.svg)](https://github.com/tbrandenburg/node-red-agents/actions/workflows/tests.yml)

<img width="1345" height="625" alt="image" src="https://github.com/user-attachments/assets/ca44c0f8-383d-431d-96aa-8c3a5815c166" />

**Node-RED nodes for agentic workflows** — drop coding agents (OpenCode,
`pi`) and GitHub CLI operations straight into a flow, wire them up like
any other node, and orchestrate them with Node-RED's visual, event-driven
programming model.

This repository *is* the source and development home of that npm
package (`packages/node-red-agents`) — plus a runnable Node-RED instance
to develop and demo it against. It is not a generic scaffold; it's one
specific, versioned, publishable package with four nodes.

## Contents

- [Nodes](#nodes)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Observing agent executions](#observing-agent-executions)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Code style](#code-style)
- [Continuous integration](#continuous-integration)
- [Releasing](#releasing)
- [Adding a node](#adding-a-node)
- [Troubleshooting: SRT sandbox errors](#troubleshooting-srt-fails-with-loopback-failed-rtm_newaddr)
- [For AI agents / automated workflows](#for-ai-agents--automated-workflows)
- [License](#license)

## Nodes

| Node | What it does |
|---|---|
| **agent** | Runs a coding-agent CLI (OpenCode v1/v2, `pi` also supported) — directly or sandboxed via [SRT](https://github.com/anthropics/sandbox-runtime) — once per input message. OpenCode's Agent dropdown offers `OpenCode` (auto-detects the installed CLI's major version), `OpenCode (v1)`, and `OpenCode (v2)` (each forcing that version); v2 supports prompt invocations and does not yet support Skill/Command dispatch. Also supports: session resume, `$INPUTS.<name>` templating, per-node retry (transient/all, with session reuse), a FIFO concurrency scheduler (runtime-overridable via `msg.concurrency`), on-demand execution termination, tool allow/deny lists, MCP server configuration, structured (JSON-Schema) output with validation + reask loop, and cost/token usage reporting where the adapter supports it. |
| **agent-server** | Manages a long-lived `opencode serve` daemon (session-based) for flows that need repeated, low-latency calls instead of `agent`'s one-shot model. Supports v1/v2 API selection (auto-detected by default), asynchronous v2 prompt completion, `message`/`status`/`abort`/`history`/`terminate`, auto-spawn, instance caps, and optional Basic Auth. SRT sandboxing is **not functional** for this node (see its built-in help). |
| **gh** | Runs [GitHub CLI](https://cli.github.com) (`gh`) commands and returns parsed JSON/text output, with structured error classification (auth, rate-limit, not-found, network, timeout, etc.) and per-message overrides via `msg.gh`. |
| **interaction** | Human-on-the-loop / human-in-the-loop decision boundary. Emits a Request, accepts a later correlated decision on the same input, and continues with the original message. Optional versioned host plan/resume API supports durable suspension. |

See each node's built-in help (Node-RED editor info panel) for the full
list of fields and behaviors, or
[`packages/node-red-agents/nodes/gh/README.md`](./packages/node-red-agents/nodes/gh/README.md)
for `gh`-specific usage and example flows.

## Human interaction

The `interaction` node has one input and two labeled outputs, **Continue** and
**Request**. Its editor contains only Name, typed Prompt and an ordered Decisions
list. Prompt must resolve to a non-empty string. Decision IDs must be unique and
match `[A-Za-z0-9][A-Za-z0-9._-]*`; optional labels are display-only and default to
the ID. The default choices are `approve` / `reject`; arbitrary choices such as
`revise` or `use-a` have exactly the same semantics.

```text
# standalone Node-RED
                     +-- Continue --> Switch(msg.interaction.decision) --> ...
                     |
A ----------------> Interaction
                     |
                     +-- Request ---> UI / HTTP / MQTT / ...
                                           |
                                           +---- later decision ----> Interaction

# durable host (AaaS / Temporal adapter)
A -> Interaction -> B
# Request may remain unwired: the host owns the external interaction surface.
```

An ordinary input starts an interaction, emitting only on Request:

```js
msg.interaction = {
  id: "<generated UUID>", status: "pending", prompt: "Continue?",
  decisions: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
};
```

Later feed a separate message into the same input with
`interaction: {id: "<that UUID>", decision: "approve", text: "Looks good"}`.
The stored original emits once on Continue with
`interaction: {id, decision, text?}`. `payload` and unrelated fields survive;
response-message fields and mutations of the Request cannot replace them.
Optional `text` must be a string. Invalid/malformed responses, undeclared
decisions, unknown/expired IDs, duplicate resolutions and unchanged pending
Request loopbacks fail through Catch. Do not wire Request directly back unchanged.
Branching is ordinary Node-RED wiring, with no built-in approve/reject policy.
The `interaction` field is reserved for this protocol: remove a previous result
before starting a subsequent Interaction boundary.

In stock Node-RED the original message is kept in a process-local map. The input
invocation completes after Request emission; no unresolved Promise or active
worker waits for the human. **Restart/redeploy loses pending interactions.**
A suspension-capable host may persist the wait and resume the same logical
interaction in a fresh worker.

### Durable host ABI (version 1)

Every live `interaction` node exposes `node.interaction`:

- `version: 1`.
- `await plan(msg)`: resolve typed Prompt and validate Decisions; return
  `{version: 1, interactionId: "<UUID>", nodeId, nodeName, prompt, decisions}`.
  This emits nothing and inserts nothing into the local map. Requires an ordinary
  input without `interaction`. The returned metadata is JSON-serializable; IDs
  are generated once per plan call, so persist and reuse the accepted plan.
- `resume(plan, originalMsg, {decision, text?})`: validate version, matching node
  ID, plan fields and response against the **plan's** decisions, clone the
  host-restored original using Node-RED's `cloneMessage`, set `interaction`, call
  real `node.send(msg)` on Continue (output 1), and return the sent message.
  Synchronous; throws on invalid input or a closed node. No local map is needed.

A host can intercept ordinary input via this optional runtime `settings.js` hook:

```js
module.exports = {
  nodeRedAgentsInteractionHost: {
    version: 1,
    async suspend({version, plan, msg}) {
      await checkpointAndPause({version, plan, msg});
    },
  },
};
```

When configured, this path takes precedence: neither local pending insertion nor
Request/Continue output occurs. `suspend` must acknowledge checkpoint acceptance
promptly, **not await the human**. Acknowledgement has a 60-second transport bound;
rejection/timeout fails the input through Catch with no local fallback or retry.
A timed-out callback may still commit; the host must reconcile/deduplicate using
`plan.interactionId`. The record's `msg` is a Node-RED clone, not a serialized
checkpoint: persistence/serialization failures must reject the pause explicitly.

To resume in a fresh worker, restore the accepted flow snapshot and original
message via the host's existing boundary, obtain
`RED.nodes.getNode(plan.nodeId)`, check `node.interaction.version === 1`, then call
`node.interaction.resume(plan, originalMsg, response)`. Node-RED routes the
existing wire to B; A is not rerun. The host owns accepted-flow/version protection,
same-run lifecycle, response authentication, checkpointing, durable correlation
and **exactly-once/deduplication across retries and workers**. `resume` is stateless
and intentionally does not deduplicate; each valid call sends. Host-mode responses
use this API, not standalone same-input lookup. No host-specific imports, storage,
network calls or second message serializer are included.

Standalone acceptance can be reproduced with
`node --test test/integration/interaction.spec.js` (isolated free-port runtime,
Admin API deploy/inject and real WebSocket debug/Complete/Catch evidence).

## Prerequisites

- Node 22+ (see `.nvmrc`)
- The [`opencode`](https://opencode.ai) CLI on your `PATH` and
  authenticated, if you want to use the `agent` node
- `srt` ([Anthropic's sandbox-runtime CLI](https://github.com/anthropics/sandbox-runtime))
  on your `PATH`, only if you want the `agent` node's SRT (sandboxed)
  runtime option
- The [`gh`](https://cli.github.com) CLI on your `PATH` and authenticated,
  if you want to use the `gh` node

## Quick start

**Using the package in your own Node-RED project:**

```sh
npm install @tbrandenburg/node-red-agents
```

Then restart Node-RED, or install it live via the editor: **Menu ->
Manage palette -> Install tab -> search "node-red-agents"**.

**Developing in this repo:**

```sh
make install   # installs node-red/nodemon + this project's data/ deps
make start     # run in the foreground, editor at http://localhost:1880
```

Use `make dev` instead of `make start` while developing a node — it
auto-restarts Node-RED when files under `data/nodes/` or
`packages/node-red-agents/` change. `make stop` stops a backgrounded
instance. `make help` lists all targets.

Want to see the nodes in action without touching your own dev flows?
`make demo` runs a separate instance (its own userDir, `demo/`, own port
`1881`) seeded with `demo/flows.json` — a showcase of `agent`,
`agent-server`, and `gh` in real dashboard flows, including an
**Agentic Development Team** tab (`/dashboard/adt`) that keeps up to 3
agents each busy on a repo's open issues, PRs, and Actions runs on a
30s schedule (see `docs/260820_Agentic_Development_Team.md`). `make
demo-stop` stops it. It never reads or writes `data/flows.json`.

## Observing agent executions

For deployment inventory and acknowledged execution starts, configure the
separate opt-in lifecycle callback in the host runtime's `settings.js`:

```js
module.exports = {
  nodeRedAgentsLifecycleObserver: async (record) => {
    if (record.type === "node.deployed" || record.type === "node.closed") {
      await updateInventory(record);
    } else if (record.type === "execution.started") {
      await allocateConversation(record); // acknowledge before the CLI starts
    } else if (record.type === "execution.terminal") {
      await saveOutcome(record);
    }
  },
};
```

Each version-1 lifecycle record has `type`, UUID `eventId`, ISO `timestamp`,
`nodeId`, UUID `deploymentId`, `agent`, and `agentName`. Inventory notices
(`node.deployed` / `node.closed`) describe availability only, without prompt,
credentials, conversation, or run ID. `deploymentId` changes on redeploy;
hosts should ignore a close for an older generation and reconcile inventory
after reconnect. Disabled nodes are not instantiated and therefore are not
announced as available. Inventory calls run in the background: one immediate
retry on rejection, at most 1 second per attempt, with warning on failure;
timed-out attempts are not retried because they may still commit remotely.
Hosts should deduplicate by `eventId`. A hung callback cannot hold up Node-RED
deployment/close; notices can be missed.

`execution.started` has `executionId`, resolved `input` (prompt or command/
skill name and args), and optional copied JSON `agentObservation`. It runs
after a scheduler slot becomes available and input resolution succeeds;
its acknowledgment is required before the CLI is invoked. This is the
authoritative moment to create a run-linked conversation using the external
correlation. It may also upsert the node if inventory was missed. Each
acknowledged start produces one `execution.terminal` attempt with the same
execution/deployment IDs, `status` (`completed`, `failed`, `timeout`), `input`,
`output`, `sessionID`, optional confirmed `resumed` (same semantics and value
as `agentExecution.resumed` on the normal result -- omitted when no resume was
requested or the adapter doesn't support it), and optional correlation,
including thrown post-start errors. Each execution waits only for its own
callback. Start/terminal
acknowledgments have a 60-second transport-safety bound (independent of the
agent's execution timeout); configure callback networking accordingly. A
start rejection or timeout fails the message through Catch without invoking
the CLI. A terminal rejection or timeout likewise fails through Catch without
re-running the agent or delivering a normal result. There is no buffered
event queue or required text stream; output 2 still carries progress events.
Without the lifecycle callback, execution and outputs retain their prior
behavior.

An embedding application can opt into one acknowledged terminal observation per
started `agent` execution by defining a function in its Node-RED runtime
`settings.js` (not in the node's editor configuration or exported flows):

```js
module.exports = {
  nodeRedAgentsExecutionObserver: async (record) => {
    await saveOutcome(record); // resolve only after the outcome is committed
  },
};
```

The observer receives a **version 1** record shaped as follows (optional fields
may be undefined when unavailable):

```js
{
  version: 1,
  eventId: "<globally unique UUID>",
  executionId: "exec-...", nodeId: "<Node-RED node id>",
  agent: "opencode", agentName: "worker", status: "completed", // or failed/timeout
  timestamp: "<ISO 8601 terminal time>",
  input: { invocation: "prompt", prompt: "resolved prompt" },
  // For skill/command: { invocation: "skill" | "command", name: "...", args: "resolved arguments" }
  output: {
    payload: "final reply", errorMessage: undefined, errorDetail: undefined,
    exitCode: 0, signal: null, timedOut: false, structuredOutput: undefined,
  },
  sessionID: "<final session id>", resumed: true,
  agentObservation: { correlation: "your opaque value" },
}
```

Pass optional JSON-serializable correlation data as `msg.agentObservation`;
the value is copied at submission and is the only input-message property
forwarded beyond the resolved prompt/arguments. A non-serializable value is
rejected before an execution starts. The observer is called once after internal
retries and structured-output reasks finish, including failed and timed-out
runs. Its Promise must resolve before the final result is delivered downstream.
If it rejects, the agent is **not retried**, no result is sent on output 1,
and Node-RED Catch nodes receive an error with `executionId`, actual terminal
`status`, and `error.cause.agentOutcome` (payload, error diagnostics and session ID) for
diagnostics. The terminal lifecycle event still reflects the actual agent
outcome. With no observer configured, outputs behave as before. The record may
contain sensitive prompt/reply/error content; configure the observer only in a
trusted host runtime and handle its storage accordingly.

## Project layout

```
Makefile              install / start / dev / stop / demo / format / lint /
                       test / test-e2e / ci / release / publish /
                       new-node-package / clean
packages/
  node-red-agents/     the publishable npm package (@tbrandenburg/node-red-agents):
                       agent, agent-server, gh, interaction nodes and their lib/
data/                  local dev Node-RED userDir: settings.js, flows
  nodes/               single-file drop-in nodes (no packaging required)
demo/                  separate Node-RED userDir for the demo flow
                       (own port, own flows.json, decoupled from data/)
test/integration/      smoke/E2E suite (see Testing below)
scripts/               helper scripts (run-and-watch.js, register-node.js)
templates/             skeleton used by `make new-node-package`
```

## Testing

Three tiers, run against `packages/node-red-agents`:

| Tier | Command | What it covers |
|---|---|---|
| Unit + node-level integration | `make test` (or `npm test`) | Every node, `node --test`, includes `node-red-node-test-helper` specs. Offline, fast — this is the CI gate. |
| Smoke / E2E | `make test-e2e` | Boots a real, throwaway Node-RED instance, deploys a minimal flow per node, asserts on real debug output. Shells out to the real `gh`/`opencode` CLIs — deliberately **not** part of `make test`. |
| Manual spot-check | `make demo` + `scripts/run-and-watch.js` | Human-in-the-loop check against the actual demo flows (see `AGENTS.md` for the round-trip workflow: inject a node, wait for its debug output over `/comms`, no browser needed). |

## Code style

Formatting ([Prettier](https://prettier.io)) and linting
([ESLint](https://eslint.org), flat config in `eslint.config.js`) are
enforced across the repo's JS (Node-RED node HTML templates and
markdown docs are excluded -- see `.prettierignore`).

```sh
make format          # check formatting (CI mode)
make format FIX=1    # rewrite files in place
make lint            # lint (CI mode)
make lint FIX=1      # lint and auto-fix what's fixable
make ci              # format + lint + test + test-e2e, the full local gate
```

## Continuous integration

`.github/workflows/tests.yml` runs on every pull request, on push to
`main`, and on manual dispatch, as three jobs (shown as `Tests / ...`
in GitHub's checks UI):

- **Format + Lint** -- `make format` + `make lint`.
- **Unit + Integration** -- `make test`. This is the required merge gate.
- **E2E** -- `make test-e2e`. Installs the `opencode` CLI and shells out
  to it and to the runner's preinstalled, no-setup `gh` CLI. The `agent`
  smoke flow pins `opencode/big-pickle`, a free, no-API-key-needed
  [OpenCode Zen](https://opencode.ai/docs/zen) model -- so this job
  needs no repo secrets at all and runs on forked PRs too. The `agent`
  node's `direct` runtime is used, so `srt`
  ([Anthropic's sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime))
  isn't needed in CI even though the `agent` node supports it.

## Releasing

`packages/node-red-agents` is versioned and published independently of
this repo's own version (`package.json` at the root is just the private
dev workspace). `make test`/`make test-e2e` (and therefore `make
release`/`make publish`, which both run `make test`) depend on `make
install`, so a fresh checkout doesn't need a separate manual install step
first.

```sh
make release BUMP=patch   # or minor / major
git push --follow-tags
make publish               # you enter your npm OTP (2FA) yourself
```

- `make release` refuses to run with an uncommitted working tree, runs
  `make test` first, bumps `packages/node-red-agents/package.json`'s
  version (and the root lockfile), then commits and tags the result as
  `node-red-agents@<version>`.
- `make publish` refuses to run unless the tree is clean,
  `packages/node-red-agents/` at HEAD matches exactly what the version's
  tag pointed at (not literally HEAD == the tag commit -- unrelated
  commits after tagging, e.g. tooling/docs, don't block a release), and
  `make test` passes again; then shows you the real `npm pack` contents
  before publishing. The actual `npm publish` step is interactive — you
  complete the OTP prompt yourself. After a real (non-dry-run) publish
  succeeds, it also creates the matching GitHub Release (`gh release
  create ... --generate-notes`), skipping cleanly if `gh` isn't
  installed/authenticated or a release for
  that tag already exists. Set `PUBLISH_DRY_RUN=1` to rehearse every
  precondition check without actually publishing or creating a release.

## Adding a node

- Quick/simple: drop a `<name>.js`/`.html` pair into `data/nodes/`.
- Real node (own tests, shareable, part of the published package):
  `make new-node-package NAME=my-node` scaffolds
  `packages/node-red-agents/nodes/my-node/` (JS, HTML, a starter test) and
  registers it in `packages/node-red-agents/package.json`'s
  `node-red.nodes` map. It's already linked into `data/` via npm
  workspaces, so a restart (`make dev` does this automatically) is all
  that's needed — no separate palette install step.

## Troubleshooting: SRT fails with "loopback: Failed RTM_NEWADDR"

If the `agent`/`agent-server` nodes' SRT runtime fails immediately with
an error like:

```
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

this is **not** a firewall or inbound-networking problem — `srt`'s
sandboxing is built on [bubblewrap](https://github.com/containers/bubblewrap)
(`bwrap`), which needs to create its own unprivileged user+network
namespace for every run (to bring up a private loopback interface, not to
open any port). Reproduce directly, independent of `srt`/`opencode`
entirely, with:

```sh
bwrap --unshare-net --dev-bind / / true
```

On Ubuntu 23.10+ (including 24.04), this fails by default because of
[AppArmor's restricted-unprivileged-user-namespaces feature](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces):
unprivileged processes can only create user namespaces if they're
confined by an AppArmor profile that explicitly grants the `userns,`
rule (or have `CAP_SYS_ADMIN`), and `bwrap` ships with no such profile.
Check whether this applies to your machine with:

```sh
sysctl kernel.apparmor_restrict_unprivileged_userns
```

If that's `1`, pick one of:

<details>
<summary><strong>Recommended: scope the exception to <code>bwrap</code> only</strong></summary>

Add a local AppArmor profile granting just `bwrap` the `userns,`
permission, then reload AppArmor:

```
# /etc/apparmor.d/usr.bin.bwrap
abi <abi/4.0>,
include <tunables/global>

/usr/bin/bwrap flags=(default_allow) {
  userns,
  include if exists <local/usr.bin.bwrap>
}
```

```sh
sudo apparmor_parser -r /etc/apparmor.d/usr.bin.bwrap
```

</details>

<details>
<summary><strong>Simplest: disable the restriction system-wide (less scoped)</strong></summary>

Affects every unprivileged-userns user on the machine, not just `bwrap`:

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

Add the same line to `/etc/sysctl.d/` to persist it across reboots.

</details>

Neither of these is something this project can (or should) configure for
you automatically — both require root and are a machine-level security
trade-off, not a per-repo setting. Machines without this AppArmor feature
(older Ubuntu, other distros, or ones where it's already relaxed) are
unaffected and need no action.

## Troubleshooting: macOS `scripts/ensure-worktree.sh` fails with "flock: command not found"

macOS doesn't ship the `flock(1)` command (it's a Linux/util-linux tool),
so ADT worktree setup fails unless it's installed, e.g.
`brew install util-linux` and add its `bin` dir to `PATH`.

## For AI agents / automated workflows

See [`AGENTS.md`](./AGENTS.md) for how to round-trip develop against a
running instance from the shell/CI (Admin HTTP API, observing debug
output without a browser, process management gotchas, etc.).

## License

[MIT](./LICENSE)
