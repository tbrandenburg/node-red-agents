"use strict";

// Registers a newly scaffolded node in packages/node-red-agents/package.json's
// node-red.nodes map. Used by `make new-node-package` -- see Makefile. Kept as
// a tiny standalone script (not a Makefile sed one-liner) because editing
// JSON structurally is more reliable via JSON.parse/stringify than text
// substitution, and this needs to stay idempotent-safe (refuses to
// clobber an existing entry).
const fs = require("fs");
const path = require("path");

const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/register-node.js <name>");
  process.exit(1);
}

const packageJsonPath = path.join(__dirname, "..", "packages", "node-red-agents", "package.json");
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

pkg["node-red"] = pkg["node-red"] || { nodes: {} };
pkg["node-red"].nodes = pkg["node-red"].nodes || {};

if (pkg["node-red"].nodes[name]) {
  console.error(`node-red.nodes already has an entry for "${name}" -- not overwriting.`);
  process.exit(1);
}

pkg["node-red"].nodes[name] = `nodes/${name}/${name}.js`;

fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`Registered "${name}" in ${path.relative(process.cwd(), packageJsonPath)}`);
