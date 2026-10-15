"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { start, leakFree } = require("./lib/model-live-instance");
const { activeTool, until, toolPids, running } = require("./lib/active-tool");

const MODEL = process.env.E2E_OPENCODE_CANCEL_MODEL || "openrouter/openai/gpt-4.1-mini";

function flow(type, options = {}) {
  return [
    { id: "live-tab", type: "tab", label: "Disposable v2 acceptance" },
    {
      id: "live-provider",
      type: "model-provider",
      provider: "openrouter",
      defaultModel: MODEL.slice("openrouter/".length),
    },
    { id: "live-inject", type: "inject", z: "live-tab", props: [], wires: [["live-target"]] },
    {
      id: "live-target",
      type,
      z: "live-tab",
      authMode: "provider",
      modelProvider: "live-provider",
      agent: "opencode-v2",
      openCodeVersionMode: "v2",
      apiVersionMode: "v2",
      runtime: "direct",
      invocation: "prompt",
      prompt: "payload",
      promptType: "msg",
      promptProp: "payload",
      operation: "message",
      model: "",
      modelType: "str",
      timeout: 55,
      timeoutType: "num",
      hostname: "127.0.0.1",
      startupTimeoutMs: 20000,
      requestTimeoutMs: 55000,
      allowedTools: ["*"],
      wires: [["final"], ["event"]],
      ...options,
    },
    { id: "live-catch", type: "catch", z: "live-tab", scope: ["live-target"], wires: [["error"]] },
    ...["final", "event", "error"].map((id) => ({
      id,
      type: "debug",
      z: "live-tab",
      active: true,
      tosidebar: true,
      complete: "true",
      targetType: "full",
      wires: [],
    })),
  ];
}

function properties(payload, sessionID, tag, operation = "message") {
  return Object.entries({ payload, sessionID, case: tag, _msgid: tag, operation })
    .filter(([, value]) => value !== undefined)
    .map(([p, v]) => ({ p, v, vt: "str" }));
}

function success(messages) {
  leakFree(messages);
  assert.equal(messages.error.length, 0, `Catch: ${JSON.stringify(messages.error)}`);
  assert.equal(messages.final.length, 1, "exactly one final output");
  return messages.final[0];
}

test(
  "real v2 Node-RED integration acceptance",
  {
    skip: process.env.E2E_OPENCODE_V2_ACCEPTANCE !== "1",
    timeout: 300000,
  },
  async (t) => {
    assert.equal(process.env.NODE_RED_AGENTS_OPENCODE_MODE, "v2", "explicit v2 mode required");
    assert.match(
      execFileSync("opencode", ["--version"], { encoding: "utf8", timeout: 10000 }),
      /v2\.0\.28\b/,
    );
    assert.ok(Boolean(process.env.OPENROUTER_API_KEY), "OPENROUTER_API_KEY required");
    assert.ok(MODEL.startsWith("openrouter/"), "acceptance requires an OpenRouter model");

    await t.test(
      "different cwd sentinel and multi-tool server turn complete only after durable idle",
      async (scenario) => {
        const cli = await start({ cli: true, acceptance: true });
        try {
          const cwd = path.join(cli.userDir, "different-cwd");
          fs.mkdirSync(cwd);
          const first = `FIRST_${randomUUID()}`;
          const second = `SECOND_${randomUUID()}`;
          fs.writeFileSync(path.join(cwd, "sentinel.txt"), first);
          fs.writeFileSync(path.join(cli.userDir, "sentinel.txt"), "WRONG_CWD");
          await cli.deploy(flow("agent", { cwd, cwdType: "str" }), process.env.OPENROUTER_API_KEY);
          const prompt =
            "Use the native shell tool directly, not execute/Code Mode. Run cat sentinel.txt in the current working directory. Reply exactly with the file contents, no explanation.";
          const direct = success(await cli.run(properties(prompt)));
          assert.equal(String(direct.payload).trim(), first);
          assert.equal(direct.agentExecution.status, "completed");

          fs.writeFileSync(path.join(cli.userDir, "sentinel.txt"), first);
          fs.writeFileSync(path.join(cli.userDir, "second.txt"), second);
          await cli.deploy(flow("agent-server"), process.env.OPENROUTER_API_KEY);
          const serverPrompt =
            "Use the native shell tool directly, not execute/Code Mode. In TWO SEPARATE sequential shell tool calls run cat sentinel.txt then cat second.txt in the current directory. Await each separately (not one combined shell call). Only after both calls finish reply with both file contents separated by a space, no explanation.";
          let finalSnapshot;
          const messages = await cli.run(properties(serverPrompt), {
            onEvent: (message, output) => {
              if (output === "final")
                finalSnapshot = cli.api(
                  message.sessionID,
                  `/api/session/${message.sessionID}/message`,
                );
            },
          });
          const result = success(messages);
          assert.equal(String(result.payload).trim(), `${first} ${second}`);
          const observed = await finalSnapshot;
          assert.equal(observed.data[0].type, "idle", "final output preceded durable idle");
          assert.equal(observed.data[0].outcome, "succeeded");
          const assistants = observed.data.filter((message) => message.type === "assistant");
          assert.ok(
            assistants.filter((message) => message.content?.some((part) => part.type === "tool"))
              .length >= 2,
            "two real tool-bearing assistant messages required",
          );
          const records = await cli.records();
          assert.equal(records.length, 1);
          assert.equal(records[0].busy, false);
          const history = success(
            await cli.run(properties(undefined, result.sessionID, undefined, "history")),
          ).payload;
          assert.deepEqual(history, observed.data);

          await scenario.test(
            "live subagent child-session permission denies shell without model delegation",
            async () => {
              const child = (
                await cli.api(result.sessionID, "/api/session", "POST", {
                  parentID: result.sessionID,
                  title: "permission child",
                  agent: "acceptance-denied",
                })
              ).data;
              const permission = (
                await cli.api(result.sessionID, `/api/session/${child.id}/permission`, "POST", {
                  action: "shell",
                  resources: ["touch forbidden"],
                  agent: "acceptance-denied",
                })
              ).data;
              assert.equal(child.parentID, result.sessionID);
              assert.equal(permission.effect, "deny");
              const pending = await cli.api(
                result.sessionID,
                `/api/session/${child.id}/permission`,
              );
              assert.deepEqual(pending.data, []);
            },
          );

          await scenario.test(
            "real history pagination beyond default 50 without paid prompts",
            async () => {
              const ids = [];
              for (let index = 0; index < 55; index++) {
                const id = `msg_${randomUUID()}`;
                ids.push(id);
                await cli.api(result.sessionID, `/api/session/${result.sessionID}/shell`, "POST", {
                  id,
                  command: `printf pagination_${index}`,
                });
              }
              const page = await cli.api(
                result.sessionID,
                `/api/session/${result.sessionID}/message`,
              );
              assert.equal(page.data.length, 50, "real default pagination boundary");
              assert.equal(typeof page.cursor.next, "string");
              const complete = success(
                await cli.run(properties(undefined, result.sessionID, undefined, "history")),
              ).payload;
              assert.ok(complete.length > 50);
              assert.equal(
                new Set(complete.map((entry) => entry.id)).size,
                complete.length,
                "no duplicate records",
              );
              assert.equal(
                ids.filter((id) => complete.some((entry) => entry.id === id)).length,
                55,
              );
              assert.ok(
                complete.some((entry) => entry.id === observed.data[0].id),
                "oldest accepted turn survives paging",
              );
            },
          );
        } finally {
          await cli.records();
          await cli.stop();
          cli.remove();
        }
      },
    );

    for (const mode of ["abort", "timeout"]) {
      await t.test(
        `active server ${mode} kills tool descendants and recovers same session`,
        { timeout: 90000 },
        async () => {
          const cli = await start({ cli: true, acceptance: true });
          const tool = activeTool(cli.userDir);
          let pending;
          try {
            await cli.deploy(
              flow("agent-server", { requestTimeoutMs: mode === "timeout" ? 22000 : 55000 }),
              process.env.OPENROUTER_API_KEY,
            );
            pending = cli.run(properties(tool.prompt, undefined, "active"), { tag: "active" });
            pending.catch(() => {});
            const admission = new AbortController();
            try {
              await Promise.race([
                until(
                  () => fs.existsSync(tool.active),
                  mode === "timeout" ? 18000 : 30000,
                  admission.signal,
                ),
                pending.then(async (messages) => {
                  if (admission.signal.aborted) return;
                  leakFree(messages);
                  const records = await cli.records();
                  const history = records[0]
                    ? await cli.api(records[0].id, `/api/session/${records[0].id}/message`)
                    : { data: [] };
                  const tools = history.data
                    .flatMap((entry) => entry.content || [])
                    .filter((part) => part.type === "tool");
                  throw new Error(
                    `server stopped before active tool: ${JSON.stringify({ final: messages.final.map((message) => message.payload), tools }).slice(0, 4000)}`,
                  );
                }),
              ]);
            } finally {
              admission.abort();
            }
            const pids = toolPids(tool.script);
            assert.equal(pids.length, 2);
            assert.ok(pids.every(running));
            const admitted = await cli.records();
            assert.equal(admitted.length, 1);
            const sessionID = admitted[0].id;
            assert.equal(admitted[0].busy, true);
            if (mode === "abort") {
              const acknowledgement = success(
                await cli.run(properties(undefined, sessionID, "abort", "abort"), {
                  tag: "abort",
                }),
              );
              assert.equal(acknowledgement.payload, true);
            }
            const failed = await pending;
            assert.equal(failed.final.length, 0, "interrupted/expired prompt emitted success");
            assert.equal(failed.error.length, 1);
            assert.equal(failed.event.filter((event) => event.payload.type === "failed").length, 1);
            await until(() => pids.every((pid) => !running(pid)), 5000);
            assert.equal(fs.existsSync(tool.late), false);
            const records = await cli.records();
            assert.equal(records[0]?.id, sessionID, "settled daemon remains reusable");
            assert.equal(records[0].busy, false);
            const recovered = success(
              await cli.run(
                properties("Reply exactly RECOVERED, no tools.", sessionID, "recover"),
                { tag: "recover" },
              ),
            );
            assert.equal(recovered.sessionID, sessionID);
            assert.match(String(recovered.payload), /RECOVERED/);
            assert.ok(!String(recovered.payload).includes("LATE_SUCCESS"));
          } finally {
            await cli.stop();
            if (pending) await pending;
            await until(() => toolPids(tool.script).every((pid) => !running(pid)), 5000);
            cli.remove();
          }
        },
      );
    }
  },
);
