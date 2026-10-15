"use strict";

const { request } = require("../../../packages/node-red-agents/nodes/agent-server/lib/http");

// Test-only observation/provisioning on the disposable runtime. Authentication
// never crosses IPC or the admin response; transport and stored records are real.
function installProbe(RED) {
  const children = new Set();
  RED.httpAdmin.get("/acceptance/record", (req, res) => {
    const node = RED.nodes.getNode("live-target");
    const records =
      node?.registry?.list().map((id) => {
        const record = node.registry.get(id);
        return { id, busy: record.busy, pid: record.child.pid, port: record.port };
      }) || [];
    res.json(records);
  });
  RED.httpAdmin.post("/acceptance/api", async (req, res) => {
    const node = RED.nodes.getNode("live-target");
    const record = node?.registry?.get(req.body.owner);
    if (!record || record.apiVersion !== "v2") return res.sendStatus(404);
    const route = req.body.route;
    const session = route?.match(
      /^\/api\/session\/(ses[^/]+)(?:\/(message|shell|permission))?(?:\?.*)?$/,
    );
    const create = route === "/api/session" && req.body.body?.parentID === req.body.owner;
    if (!create && (!session || ![req.body.owner, ...children].includes(session[1]))) {
      return res.sendStatus(400);
    }
    try {
      const result = await request(record.baseUrl + route, {
        ...record.auth,
        method: req.body.method || "GET",
        body: req.body.body,
        timeoutMs: 10000,
        redactErrors: true,
      });
      if (create) children.add(result.data.id);
      res.json(record.sanitize(result) ?? null);
    } catch (error) {
      res.status(500).json({ error: record.sanitize(error.message) });
    }
  });
}

module.exports = { installProbe };
