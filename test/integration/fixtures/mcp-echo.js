"use strict";

const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (_err) {
    return;
  }

  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "node-red-smoke-mcp", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [
        {
          name: "echo_marker",
          description: "Returns a fixed smoke-test marker",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    respond(message.id, {
      content: [{ type: "text", text: "MCP_TOOL_VERIFIED_6d28a6" }],
    });
  }
});
