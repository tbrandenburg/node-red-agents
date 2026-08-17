# AGENTS.md

A Node-RED node package for agentic workflows (`@tbrandenburg/node-red-agents`
-- `agent`, `agent-server`, `gh`) plus the local Node-RED runtime this
repo uses to develop and demo it. See the Makefile for the supported
commands (`make help`).

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
- `make demo` / `make demo-stop` run a *separate* instance against
  `demo/` (own userDir, own port `1881`, own pidfile) seeded from
  `demo/flows.json` -- a showcase flow, not a dev sandbox. It never
  reads or writes `data/flows.json`; use it for a clean, disposable
  round-trip check without disturbing real dev work in `data/`.

## Testing

- `make test` (or `npm test` from repo root) -- unit + node-level
  integration tests (`node --test` across `packages/node-red-agents`).
  Offline, no real CLIs invoked, this is the CI-facing gate. Run this
  after any change to `packages/node-red-agents/**`.
- `make test-e2e` -- smoke/E2E suite (`test/integration/`): boots a real,
  throwaway Node-RED instance and shells out to the real `gh`/`opencode`
  CLIs. Deliberately not part of `make test`; only run it when those
  CLIs are installed and authenticated.

## Releasing

- `make release BUMP=patch|minor|major` bumps
  `packages/node-red-agents/package.json`'s version, commits, and tags
  `node-red-agents@<version>`. Refuses to run on a dirty tree or if
  `make test` fails.
- `make publish` verifies the tree is clean, HEAD is the tagged release
  commit, and `make test` passes, then runs the real `npm publish` --
  which needs the human's own npm OTP (2FA), so an agent should never
  attempt to complete this step itself. Use `PUBLISH_DRY_RUN=1 make
  publish` to rehearse every precondition without publishing.

## Custom nodes

- `packages/node-red-agents/nodes/<name>/` holds all custom nodes
  (`agent`, `agent-server`, `gh`, and any new ones), published together
  as the single `@tbrandenburg/node-red-agents` npm package
  (`packages/node-red-agents/package.json`'s `node-red.nodes` map lists
  all of them). It's linked into `data/` via npm workspaces
  (`data/package.json`'s `@tbrandenburg/node-red-agents` dependency) --
  restarting Node-RED is enough to pick up a new node, no palette
  install step.
- `make new-node-package NAME=x` scaffolds
  `packages/node-red-agents/nodes/x/` (JS, HTML, starter test) and
  registers it in `packages/node-red-agents/package.json` via
  `scripts/register-node.js`.
- Nodes needing their own npm deps:
  `cd packages/node-red-agents && npm install <pkg>` (shared across all
  nodes in the package -- there is no per-node dependency isolation).
- `POST /nodes {"module": "<absolute path>"}` against the admin API (see
  below) is only needed for installing a *separate*, not-yet-workspaced
  package (e.g. while prototyping outside `packages/node-red-agents`).
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

## Debugging a flow from the shell

Use the runtime APIs instead of Playwright when debugging a flow:

1. Read the current graph: `curl -sS http://127.0.0.1:1880/flows`.
2. Identify the inject node, target node, and a debug node connected to the
   output under test.
3. For a flow without a debug node, deploy a temporary copy that adds one,
   run the test, then restore the original flow from the saved `GET /flows`
   response. Do not overwrite `data/flows.json` with test-only nodes.
4. Run `node scripts/run-and-watch.js <injectId> <debugId> [maxWaitMs]`.
   It subscribes to `/comms`, injects the message, and prints the first
   matching result or red node status.
5. If the watcher times out, subscribe to `status/#` and `debug` directly
   with a small Node 22+ WebSocket script to distinguish node status, output,
   and transport problems. Check the Node-RED process log for node errors.

Always restore temporary deployments, verify `POST /flows` returns `204`,
and check `git diff` before finishing. For nodes that spawn child processes,
use captured PIDs or `make stop`; never use broad `pkill` patterns.

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
- `demo/flows.json` is also intentionally tracked -- it's the demo flow
  (see `docs/260817_Refactoring.md` step 13), curated by hand, not
  test-only scratch content. `demo/node_modules/`, `demo/package-lock.json`,
  `demo/.config.*.json`, `demo/.node-red.pid` are regenerable and
  gitignored, same as their `data/` counterparts.
