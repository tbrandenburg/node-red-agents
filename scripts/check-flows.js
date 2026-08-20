// Referential integrity check for a Node-RED flows.json export: every
// `wires` target id exists, every `z` points at a real tab/subflow, every
// `group`/`page`/`ui` reference resolves, no duplicate node ids, and every
// subflow instance's `type` (`subflow:<id>`) matches a defined subflow.
//
// Usage: node scripts/check-flows.js [path/to/flows.json]  (default demo/flows.json)
const fs = require("fs");
const path = require("path");

const file = process.argv[2] || path.join(__dirname, "..", "demo", "flows.json");
const flows = JSON.parse(fs.readFileSync(file, "utf8"));

const problems = [];
const byId = new Map();
for (const node of flows) {
  if (byId.has(node.id)) problems.push(`duplicate node id: ${node.id}`);
  byId.set(node.id, node);
}
const subflowIds = new Set(flows.filter((n) => n.type === "subflow").map((n) => n.id));
const containerIds = new Set(
  flows.filter((n) => n.type === "tab" || n.type === "subflow").map((n) => n.id),
);

for (const node of flows) {
  if (node.z !== undefined && !containerIds.has(node.z)) {
    problems.push(`${node.id}: z "${node.z}" is not a known tab/subflow`);
  }
  if (node.group && !byId.has(node.group)) {
    problems.push(`${node.id}: group "${node.group}" does not resolve`);
  }
  if (node.page && !byId.has(node.page)) {
    problems.push(`${node.id}: page "${node.page}" does not resolve`);
  }
  if (node.ui && !byId.has(node.ui)) {
    problems.push(`${node.id}: ui "${node.ui}" does not resolve`);
  }
  if (typeof node.type === "string" && node.type.startsWith("subflow:")) {
    const subflowId = node.type.slice("subflow:".length);
    if (!subflowIds.has(subflowId)) {
      problems.push(`${node.id}: instance type "${node.type}" has no matching subflow`);
    }
  }
  for (const wireGroup of node.wires || []) {
    for (const targetId of wireGroup) {
      if (!byId.has(targetId)) {
        problems.push(`${node.id}: wires target "${targetId}" does not exist`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`FAILED: ${problems.length} problem(s) in ${file}`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`OK: ${flows.length} nodes checked in ${file}, no referential integrity problems`);
