"use strict";

// Opt-in acceptance: real v2 CLI, provider and detached shell tool. No shared
// service, user configuration, Node-RED userDir or credentials are modified.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const {
  OpenCodeAdapter,
} = require("../../packages/node-red-agents/nodes/agent/lib/agents/opencode");
const { DirectRuntime } = require("../../packages/node-red-agents/nodes/agent/lib/runtimes/direct");
const { SrtRuntime } = require("../../packages/node-red-agents/nodes/agent/lib/runtimes/srt");
const { runAgent } = require("../../packages/node-red-agents/nodes/agent/lib/execution/lifecycle");
const { resolveCLIAuth } = require("../../packages/node-red-agents/shared/cli-provider-auth");
const { privateCLIProfile } = require("./lib/private-cli-profile");
const { until, running, toolPids, activeTool, descendants } = require("./lib/active-tool");

test(
  "real v2 active CLI cancellation: direct terminate/timeout and SRT terminate",
  { skip: process.env.E2E_OPENCODE_CANCEL !== "1", timeout: 180000 },
  async (t) => {
    assert.match(
      execFileSync("opencode", ["--version"], { encoding: "utf8", timeout: 10000 }),
      /v2\./,
    );
    assert.ok(Boolean(process.env.OPENROUTER_API_KEY), "OPENROUTER_API_KEY is required");
    const modes = process.env.E2E_OPENCODE_CANCEL_MODES?.split(",") || [
      "terminate",
      "timeout",
      "srt",
    ];
    for (const mode of modes) {
      assert.ok(["terminate", "timeout", "srt"].includes(mode), "unknown cancellation mode");
      await t.test(mode, { timeout: 55000 }, async () => {
        const root = fs.existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();
        const dir = fs.mkdtempSync(path.join(root, "opencode-cancel-"));
        execFileSync("ss", ["-H", "-ltn"], { timeout: 5000 });
        const env = privateCLIProfile(dir, { tools: true });
        env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
        const { active, late, script, prompt } = activeTool(dir);
        const settings = path.join(dir, "srt.json");
        fs.writeFileSync(
          settings,
          JSON.stringify({
            filesystem: { allowWrite: [dir], denyRead: [], denyWrite: [] },
            network: {
              allowedDomains: ["openrouter.ai", "models.dev", "registry.npmjs.org"],
              deniedDomains: [],
              allowLocalBinding: true,
            },
          }),
        );
        const runtime =
          mode === "srt" ? new SrtRuntime({ settingsPath: settings }) : new DirectRuntime();
        const id = `real-cancel-${mode}-${path.basename(dir)}`;
        const statuses = [];
        const events = [];
        let pending;
        let owned = [];
        try {
          const model = process.env.E2E_OPENCODE_CANCEL_MODEL || "openrouter/openai/gpt-4.1-mini";
          pending = runAgent({
            adapter: new OpenCodeAdapter({ fixedVersion: 2 }),
            runtime,
            resolved: {
              invocation: "prompt",
              cwd: dir,
              model,
              auto: true,
              timeoutMs: mode === "timeout" ? 30000 : 45000,
              prompt,
            },
            executionId: id,
            onStatus: (status) => statuses.push(status),
            onEvent: (event) => events.push(event),
            resolveAuth: () =>
              resolveCLIAuth(
                undefined,
                {
                  authMode: "environment",
                  agent: "opencode-v2",
                  model,
                },
                env,
              ),
          });
          const admission = new AbortController();
          try {
            await Promise.race([
              until(() => fs.existsSync(active), 25000, admission.signal),
              pending.then((result) => {
                const detail = String(
                  result.errorMessage ||
                    `${result.status}: ${result.payload}; tools=${JSON.stringify(result.events.filter((event) => event.type === "tool").map((event) => event.data.part))}`,
                )
                  .replaceAll(process.env.OPENROUTER_API_KEY, "[redacted]")
                  .slice(0, 1500);
                throw new Error(`CLI stopped before active tool: ${detail}`);
              }),
            ]);
          } finally {
            admission.abort();
          }
          const pids = toolPids(script);
          owned = descendants(process.pid);
          assert.equal(
            pids.length,
            2,
            "capture exactly the real tool and its descendant host PIDs",
          );
          assert.ok(
            pids.every(running),
            "real tool and its descendant must be active before cancellation",
          );
          const before = events.length;
          const started = Date.now();
          if (mode !== "timeout") await runtime.terminate(id);
          const result = await pending;
          assert.equal(result.status, mode === "timeout" ? "timeout" : "failed");
          assert.deepEqual(statuses, ["running", result.status]);
          assert.equal(result.timedOut, mode === "timeout");
          if (mode !== "srt") {
            assert.equal(
              result.exitCode,
              130,
              "v2 run's SIGINT session-interrupt handler must finish",
            );
            assert.equal(
              result.signal,
              null,
              "graceful interruption must precede forced CLI termination",
            );
          }
          assert.ok(
            Date.now() - started < 36000,
            "cancellation must finish within its deadline and grace period",
          );
          await until(() => pids.every((pid) => !running(pid)), 3000);
          assert.equal(
            fs.existsSync(late),
            false,
            "cancelled tool must not finish its delayed write",
          );
          assert.ok(
            !events.slice(before).some((event) => event.data?.part?.text?.includes("LATE_SUCCESS")),
          );
          assert.ok(!String(result.payload).includes("LATE_SUCCESS"));
          console.log(
            `real v2 ${mode}: active tool + descendant stopped; status=${result.status}; exit=${result.exitCode}; signal=${result.signal}; no late success`,
          );
        } finally {
          await runtime.terminate(id);
          if (pending) await pending;
          await until(() => [...owned, ...toolPids(script)].every((pid) => !running(pid)), 5000);
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  },
);
