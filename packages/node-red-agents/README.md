# node-red-agents

Node-RED nodes for running coding agents and GitHub CLI operations from a
flow.

## Nodes

- **agent** — runs a coding-agent CLI (OpenCode first, `pi` also
  supported) either directly or sandboxed via SRT (Anthropic's
  sandbox-runtime), one execution per input message. Also supports
  session resume, `$INPUTS.<name>` templating, retry with session
  reuse, a FIFO concurrency scheduler, on-demand termination, tool
  allow/deny lists, MCP server configuration, structured (JSON-Schema)
  output validation, and cost/token usage reporting where supported.
- **agent-server** — manages a long-lived `opencode serve` daemon
  (session-based), for flows that need repeated low-latency calls
  instead of `agent`'s one-shot execution model. Supports
  `message`/`status`/`abort`/`history`/`terminate` operations, an
  instance cap (`maxInstances`), and optional basic auth. SRT
  sandboxing is **not functional** for this node (see its built-in
  help) since it only sandboxes outbound egress, not the inbound calls
  this node needs.
- **gh** — runs GitHub CLI (`gh`) commands and returns parsed output,
  with structured error classification and per-message overrides.
- **interaction** — human-on-the-loop / human-in-the-loop boundary with one
  input and Continue/Request outputs. Name, typed Prompt and ordered Decisions
  are its editor settings. Ordinary input emits a pending Request; a separate
  later message carrying `interaction.id` and a declared `interaction.decision`
  resumes the stored original message with `{id, decision, text?}` without
  changing payload. Decision meanings belong to ordinary Switch/Change wiring.
  Pending messages are process-local and lost on restart/redeploy; the initial
  invocation completes without waiting for the human. A durable host can use
  the version-1 `node.interaction.plan(msg)` and
  `node.interaction.resume(plan, originalMsg, response)` APIs; the host owns
  checkpointing and deduplication, and resume uses normal Node-RED routing.
  See the [interaction contract and host ABI](https://github.com/tbrandenburg/node-red-agents#human-interaction).

See each node's built-in help (Node-RED editor info panel) for
configuration details, or `nodes/gh/README.md` for `gh`-specific usage
and example flows (`nodes/gh/examples/`).

## Requirements

- Node-RED >= 4.0.0, Node.js >= 20
  (Node.js 20 compatibility is verified for these nodes; the monorepo's own
  dev/CI tooling still targets Node.js 22, see the repo root `.nvmrc`)
- The [`opencode`](https://opencode.ai) CLI on `PATH` (for `agent`/`agent-server`)
- [`srt`](https://github.com/anthropics/sandbox-runtime) on `PATH`, only if using the SRT runtime option
- The [`gh`](https://cli.github.com) CLI on `PATH`, authenticated (for `gh`)

## Install

```sh
npm install @tbrandenburg/node-red-agents
```

Then restart Node-RED, or install via the editor: **Menu -> Manage
palette -> Install tab -> search "node-red-agents"**.
