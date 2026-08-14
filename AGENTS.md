# AGENTS.md

Local Node-RED runtime + custom node development workspace. See the
Makefile for the supported commands (`make help`).

## Running Node-RED

- `make install` - installs node-red/nodemon (root) and this project's
  `data/` userDir dependencies (e.g. the editor theme).
- `make start` / `make dev` - run in the foreground (Ctrl+C to stop).
  Both also write the pid to `data/.node-red.pid`.
- `make stop` - stops a backgrounded `start`/`dev` instance. It kills the
  whole process group, not just one pid -- important because `dev` runs
  node-red as a child of nodemon, and killing nodemon alone leaves
  node-red running as an orphan still bound to the port.
- Requires Node 22+ (see `.nvmrc`). Don't `pkill -f "node-red ..."` --
  node-red overwrites its own process title to just `node-red`, so the
  full command line isn't matchable; use `make stop` or kill a pid you
  actually captured (e.g. from `data/.node-red.pid`).

## Custom nodes

- `custom-nodes/<name>/` are standalone npm packages with a `node-red`
  field in `package.json`. `make new-node-package NAME=x` scaffolds one.
- Nodes needing their own npm deps: `cd custom-nodes/<name> && npm install <pkg>`.
- Install/link a node into the running instance via the editor: **Menu ->
  Manage palette -> Install tab -> full path to `custom-nodes/<name>`**.
  This is equivalent to `POST /nodes {"module": "<absolute path>"}` against
  the admin API (see below) -- use that when working headlessly.
- After editing the JS/HTML of an *already-loaded* node, Node-RED must be
  **restarted** to pick up the change (re-POSTing to `/nodes` just replies
  `module_already_loaded`; there's no hot-reload for installed node code).
- `data/nodes/` is for quick single-file drop-in nodes (no packaging) --
  see `data/nodes/README.md`.

## Controlling a running instance from the shell (Admin HTTP API)

No browser needed; the same API the editor UI uses is directly callable:

- `GET /flows` - full current flow JSON (array of tabs/nodes).
- `POST /flows` (JSON array body) - deploy a full flow config, `204` on success.
- `POST /inject/<nodeId>` - fire an inject node.
- `POST /nodes {"module": "<path-or-npm-name>"}` - install/link a node package.

## Observing live results (debug/status) without a browser

By default, debug nodes only show output in the editor's browser sidebar
(`console` option off) -- nothing is printed to the node-red process log.
To see it from the shell:

- Connect a WebSocket to `ws://<host>:<port>/comms` (**plural** -- `/comm`
  looks like it hangs: node-red's upgrade handler silently ignores an
  unrecognized path instead of rejecting the connection, so a wrong path
  just times out with zero bytes, which looks like a bug but isn't one).
- After connecting, send `{"subscribe":"debug"}` and/or
  `{"subscribe":"status/#"}` -- nothing arrives until you subscribe.
- Messages arrive as JSON arrays of `{topic, data}`. Debug events have
  `topic:"debug"` and `data.id` = the debug node's id; status events have
  `topic:"status/<nodeId>"`.
- Node 22+ has a built-in global `WebSocket`/`fetch` -- no need to `npm
  install ws` for a throwaway script.

## Round-tripping changes (react, don't sleep-and-poll)

Firing an inject with `curl` and then `sleep N` before checking a log file
wastes time (fixed delay tax on top of the real run time) and is flaky
(N might still be too short). Instead, use a script that subscribes over
`/comms`, triggers the inject itself, and returns the instant the target
debug/status event arrives, with a timeout only as a safety net:

```
node scripts/run-and-watch.js <injectNodeId> <debugNodeId> [maxWaitMs]
```

Typical workflow for iterating on someone's live flow:

1. `GET /flows` to read the current graph and find the relevant node ids.
2. Edit the JSON, `POST /flows` to deploy (`204` = success).
3. `node scripts/run-and-watch.js <injectId> <debugId>` to run it and get
   the result back as soon as it's actually ready.

## child_process gotchas (nodes that shell out, e.g. agent, opencode-run)

`spawn()`'s default stdio leaves the child's stdin open as an unclosed
pipe. Some CLIs (e.g. `opencode`) hang indefinitely waiting on it instead
of behaving like a normal non-interactive invocation. Always pass
`stdio: ['ignore', 'pipe', 'pipe']` when spawning a child that isn't
meant to read stdin.

## Data hygiene

- `data/flows.json` / `data/flows_cred.json` are real, potentially
  unsaved user work created through the browser editor -- never delete
  or reset them as "test cleanup" without checking first.
- `data/node_modules/`, `data/package-lock.json`, `data/.config.*.json`,
  `data/lib/`, `data/.node-red.pid` are regenerable and gitignored --
  safe to delete freely.
