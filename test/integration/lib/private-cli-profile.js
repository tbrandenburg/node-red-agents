"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Deliberately allowlist, rather than inherit then try to blacklist credentials
// and service/config overrides. The caller provisions one provider key explicitly.
function privateCLIProfile(directory, { version = "v2", tools = false } = {}) {
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", PWD: directory, TMPDIR: directory };
  env.CLAUDE_CODE_TMPDIR = directory;
  for (const [name, suffix] of Object.entries({
    HOME: "home",
    XDG_CONFIG_HOME: "config",
    XDG_DATA_HOME: "share",
    XDG_CACHE_HOME: "cache",
    XDG_STATE_HOME: "state",
  })) {
    env[name] = path.join(directory, suffix);
    fs.mkdirSync(env[name], { recursive: true });
  }
  env.OPENCODE_DB = path.join(directory, "opencode.db");
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(
    version === "v2"
      ? {
          update: "disable",
          share: "disabled",
          permissions: [{ action: "*", resource: "*", effect: tools ? "allow" : "deny" }],
          ...(tools
            ? {
                agents: {
                  "acceptance-denied": {
                    mode: "subagent",
                    description: "Acceptance permission probe",
                    permissions: [{ action: "shell", resource: "*", effect: "deny" }],
                  },
                },
              }
            : {}),
          providers: { openrouter: { settings: { timeout: 55000, maxRetries: 0 } } },
        }
      : {
          autoupdate: false,
          share: "disabled",
          permission: { "*": tools ? "allow" : "deny" },
          server: { hostname: "127.0.0.1" },
          provider: { openrouter: { options: { timeout: 55000, maxRetries: 0 } } },
        },
  );
  return env;
}

module.exports = { privateCLIProfile };
