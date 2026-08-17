# nodered-agents

Local Node-RED runtime and custom node development workspace, geared
towards building nodes that call out to AI agents/CLIs (e.g. `opencode`)
and other external tools from a flow.

## Prerequisites

- Node 22+ (see `.nvmrc`)
- The [`opencode`](https://opencode.ai) CLI on your `PATH` and
  authenticated, if you want to use the `agent` node
- `srt` (Anthropic's sandbox-runtime CLI) on your `PATH`, only if you want
  to use the `agent` node's SRT (sandboxed) runtime option
- The [`gh`](https://cli.github.com) CLI on your `PATH` and authenticated,
  if you want to use the `gh` node

### Troubleshooting: SRT fails with "loopback: Failed RTM_NEWADDR"

If the `agent`/`agent-server` nodes' SRT runtime fails immediately with
an error like:

```
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

this is **not** a firewall or inbound-networking problem -- `srt`'s
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

- **Recommended (scoped to `bwrap` only)**: add a local AppArmor profile
  granting just `bwrap` the `userns,` permission, then reload AppArmor:

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

- **Simplest (system-wide, less scoped)**: disable the restriction
  entirely (affects every unprivileged-userns user on the machine, not
  just `bwrap`):

  ```sh
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  ```

  Add the same line to `/etc/sysctl.d/` to persist it across reboots.

Neither of these is something this project can (or should) configure for
you automatically -- both require root and are a machine-level security
trade-off, not a per-repo setting. Machines without this AppArmor feature
(older Ubuntu, other distros, or ones where it's already relaxed) are
unaffected and need no action.

## Quick start

```sh
make install   # installs node-red/nodemon + this project's data/ deps
make start     # run in the foreground, editor at http://localhost:1880
```

Use `make dev` instead of `make start` while developing a node -- it
auto-restarts Node-RED when files under `data/nodes/` or
`packages/node-red-agents/` change. `make stop` stops a backgrounded
instance. `make help` lists all targets.

Want to see the nodes in action without touching your own dev flows?
`make demo` runs a separate instance (its own userDir, `demo/`, own port
`1881`) seeded with `demo/flows.json` -- a showcase of `agent`,
`agent-server`, and `gh` in real dashboard flows. `make demo-stop` stops
it. It never reads or writes `data/flows.json`.

## Project layout

```
Makefile              install / start / dev / stop / demo / test / test-e2e /
                      release / publish / new-node-package / clean
data/                  Node-RED userDir: settings.js, flows, drop-in nodes
  nodes/               single-file custom nodes (no packaging required)
packages/
  node-red-agents/     the publishable npm package: agent, agent-server,
                        gh nodes (see nodes/agent/lib/, nodes/agent-server/lib/)
demo/                  Node-RED userDir for the demo flow (own port, own
                        flows.json, decoupled from data/'s dev sandbox)
templates/             skeleton used by `make new-node-package`
scripts/               helper scripts (see run-and-watch.js, register-node.js)
test/integration/      smoke/E2E suite (see Testing below)
```

## Testing

Three tiers, run against `packages/node-red-agents`:

- `make test` (or `npm test` from repo root) -- unit + node-level
  integration tests for every node (`node --test`, includes
  `node-red-node-test-helper` specs under each node's
  `test/integration/`). Offline, fast, this is the CI gate.
- `make test-e2e` -- smoke/E2E suite (`test/integration/` at repo root):
  boots a real, throwaway Node-RED instance per run, deploys a minimal
  flow per node, and asserts on the real debug output. Shells out to the
  real `gh`/`opencode` CLIs (must be installed and authenticated) --
  deliberately **not** part of `make test`/CI's default gate.
- `make demo` + `scripts/run-and-watch.js` -- manual, human-in-the-loop
  spot-checking against the actual demo flows (see `AGENTS.md` for the
  round-trip workflow: inject a node, wait for its debug output over
  `/comms`, without a browser).

## Releasing

`packages/node-red-agents` is versioned and published independently of
this repo's own version (`package.json` at the root is just the private
dev workspace).

```sh
make release BUMP=patch   # or minor / major
git push --follow-tags
make publish               # you enter your npm OTP (2FA) yourself
```

- `make release` refuses to run with an uncommitted working tree, runs
  `make test` first, bumps `packages/node-red-agents/package.json`'s
  version (and the root lockfile), then commits and tags the result as
  `node-red-agents@<version>`.
- `make publish` refuses to run unless the tree is clean, HEAD is exactly
  the tagged release commit, and `make test` passes again; then shows you
  the real `npm pack` contents before publishing. The actual
  `npm publish` step is interactive -- you complete the OTP prompt
  yourself. Set `PUBLISH_DRY_RUN=1` to rehearse every precondition check
  without actually publishing.

## Adding a node

- Quick/simple: drop a `<name>.js`/`.html` pair into `data/nodes/`.
- Real node (own tests, shareable, part of the published package):
  `make new-node-package NAME=my-node` scaffolds
  `packages/node-red-agents/nodes/my-node/` (JS, HTML, a starter test) and
  registers it in `packages/node-red-agents/package.json`'s
  `node-red.nodes` map. It's already linked into `data/` via npm
  workspaces, so a restart (`make dev` does this automatically) is all
  that's needed -- no separate palette install step.

## For AI agents / automated workflows

See [`AGENTS.md`](./AGENTS.md) for how to round-trip develop against a
running instance from the shell/CI (Admin HTTP API, observing debug
output without a browser, process management gotchas, etc.).
