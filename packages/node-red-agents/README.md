# node-red-agents

Node-RED nodes for coding agents, direct model requests, typed probabilistic
decisions, human interaction and GitHub CLI operations.

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
- **model-provider** — reusable OpenRouter or Vercel AI Gateway configuration.
  Stores API keys as native password credentials, separate from flow exports.
  Supports default/allowed models, timeout and trusted-admin custom URLs.
- **model** — direct generation, schema-validated structured output and embeddings
  through the AI SDK, without invoking a coding-agent CLI. Output 1 supplies
  `msg.modelResult`; optional output 2 emits `msg.modelEvent` text deltas.
- **decision** — Jev Boolean, Choice and Score questions with typed probabilities
  and available metadata in `msg.decisionResult`. Use Switch/interaction nodes
  for explicit thresholds and human review.

The agent nodes retain default CLI authentication. Optional shared-provider mode
uses explicit supported provider mappings in child-process environments; saved
CLI authentication may take precedence. Restart server daemons after rotating keys.
See the [provider compatibility and message contracts](https://github.com/tbrandenburg/node-red-agents#direct-models-and-shared-credentials).

See each node's built-in help (Node-RED editor info panel) for
configuration details, or `nodes/gh/README.md` for `gh`-specific usage
and example flows (`nodes/gh/examples/`).

## Requirements

- Node-RED >= 4.0.0, Node.js >= 22 (required by the pinned AI SDK).
- The [`opencode`](https://opencode.ai) CLI on `PATH` (for `agent`/`agent-server`)
- [`srt`](https://github.com/anthropics/sandbox-runtime) on `PATH`, only if using the SRT runtime option
- The [`gh`](https://cli.github.com) CLI on `PATH`, authenticated (for `gh`)
- An OpenRouter or AI Gateway API key and supported model IDs for direct model
  and decision requests. Direct SDK nodes do not require a coding-agent CLI.

## Install

```sh
npm install @tbrandenburg/node-red-agents
```

Then restart Node-RED, or install via the editor: **Menu -> Manage
palette -> Install tab -> search "node-red-agents"**.
