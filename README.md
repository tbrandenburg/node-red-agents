# generic-nodered-agents

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

## Quick start

```sh
make install   # installs node-red/nodemon + this project's data/ deps
make start     # run in the foreground, editor at http://localhost:1880
```

Use `make dev` instead of `make start` while developing a node -- it
auto-restarts Node-RED when files under `data/nodes/` or `custom-nodes/`
change. `make stop` stops a backgrounded instance. `make help` lists all
targets.

## Project layout

```
Makefile             install / start / dev / stop / new-node-package / clean
data/                 Node-RED userDir: settings.js, flows, drop-in nodes
  nodes/              single-file custom nodes (no packaging required)
custom-nodes/         standalone npm packages, one per custom node
  example-node/       minimal template node
  agent/               generic coding-agent node (OpenCode first; Direct
                       and SRT sandboxed runtimes); see custom-nodes/agent/lib/
  gh/                  runs GitHub CLI (gh) commands, returns parsed output
templates/            skeleton used by `make new-node-package`
scripts/              helper scripts (see run-and-watch.js)
```

## Adding a node

- Quick/simple: drop a `<name>.js`/`.html` pair into `data/nodes/`.
- Real package (own npm deps, shareable): `make new-node-package
  NAME=my-node`, then install it from the editor: **Menu -> Manage
  palette -> Install tab -> full path to `custom-nodes/my-node`**.

## For AI agents / automated workflows

See [`AGENTS.md`](./AGENTS.md) for how to round-trip develop against a
running instance from the shell/CI (Admin HTTP API, observing debug
output without a browser, process management gotchas, etc.).
