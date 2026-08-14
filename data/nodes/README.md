# Drop-in custom nodes

`settings.js` sets `nodesDir: 'nodes'`, so Node-RED scans this folder
(and only this folder) for standalone custom nodes: a `<name>.js` file
paired with an optional `<name>.html` file. No `package.json` or
`npm install` required — just add the files and restart Node-RED
(`make dev` restarts automatically on change).

This is the fastest way to prototype a node. `example-lower-case.js/.html`
is a working example — copy the pair, rename, edit.

Once a node is ready to share/publish or needs its own npm dependencies,
move it to a real package under `../../custom-nodes/` instead (see
`custom-nodes/example-node` and `custom-nodes/gh` for examples, or use
`node-red-nodegen` to scaffold one), then install it from the editor:
Menu -> Manage palette -> Install tab -> enter the full path to the
package folder.
