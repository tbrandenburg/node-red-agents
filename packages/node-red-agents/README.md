# node-red-agents

Node-RED nodes for running coding agents and GitHub CLI operations from a
flow.

## Nodes

- **agent** — runs a coding-agent CLI (OpenCode first, `pi` also
  supported) either directly or sandboxed via SRT (Anthropic's
  sandbox-runtime), one execution per input message.
- **agent-server** — manages a long-lived `opencode serve` daemon
  (session-based, SRT-sandboxable), for flows that need repeated
  low-latency calls instead of `agent`'s one-shot execution model.
- **gh** — runs GitHub CLI (`gh`) commands and returns parsed output.

See each node's built-in help (Node-RED editor info panel) for
configuration details, or `nodes/gh/README.md` for `gh`-specific usage
and example flows (`nodes/gh/examples/`).

## Requirements

- Node-RED >= 4.0.0, Node.js >= 22
- The [`opencode`](https://opencode.ai) CLI on `PATH` (for `agent`/`agent-server`)
- [`srt`](https://github.com/anthropics/sandbox-runtime) on `PATH`, only if using the SRT runtime option
- The [`gh`](https://cli.github.com) CLI on `PATH`, authenticated (for `gh`)

## Install

```sh
npm install node-red-agents
```

Then restart Node-RED, or install via the editor: **Menu -> Manage
palette -> Install tab -> search "node-red-agents"**.
