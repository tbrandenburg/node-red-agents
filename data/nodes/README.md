# Drop-in custom nodes

`settings.js` sets `nodesDir: 'nodes'`, so Node-RED scans this folder
(and only this folder) for standalone custom nodes: a `<name>.js` file
paired with an optional `<name>.html` file. No `package.json` or
`npm install` required — just add the files and restart Node-RED
(`make dev` restarts automatically on change).

This is the fastest way to prototype a node. `example-lower-case.js/.html`
is a working example — copy the pair, rename, edit.

Once a node is ready to share/publish or needs its own npm dependencies,
scaffold it into the real package via `make new-node-package NAME=my-node`
(from repo root) -- this creates
`../../packages/node-red-agents/nodes/my-node/` (JS, HTML, starter test)
and registers it automatically; no separate palette install step needed,
since `node-red-agents` is already linked into `data/` via npm workspaces.
See `agent` or `gh` under `../../packages/node-red-agents/nodes/` for
real examples.
