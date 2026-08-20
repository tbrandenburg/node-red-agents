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
specific, versioned, publishable package with three nodes.

## Contents

- [Nodes](#nodes)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
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
| **agent** | Runs a coding-agent CLI (OpenCode first, `pi` also supported) — directly or sandboxed via [SRT](https://github.com/anthropics/sandbox-runtime) — once per input message. |
| **agent-server** | Manages a long-lived `opencode serve` daemon (session-based, SRT-sandboxable) for flows that need repeated, low-latency calls instead of `agent`'s one-shot model. |
| **gh** | Runs [GitHub CLI](https://cli.github.com) (`gh`) commands and returns parsed JSON/text output. |

See each node's built-in help (Node-RED editor info panel), or
[`packages/node-red-agents/nodes/gh/README.md`](./packages/node-red-agents/nodes/gh/README.md)
for `gh`-specific usage and example flows.

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

> Not yet published to npm — building from source (below) works today;
> `npm install` will work once the first release ships.

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

## Project layout

```
Makefile              install / start / dev / stop / demo / format / lint /
                       test / test-e2e / ci / release / publish /
                       new-node-package / clean
packages/
  node-red-agents/     the publishable npm package (@tbrandenburg/node-red-agents):
                       agent, agent-server, gh nodes and their lib/
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

## For AI agents / automated workflows

See [`AGENTS.md`](./AGENTS.md) for how to round-trip develop against a
running instance from the shell/CI (Admin HTTP API, observing debug
output without a browser, process management gotchas, etc.).

## License

[MIT](./LICENSE)
