"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const api = require("../lib/api");

const user = { id: "msg_user", type: "user" };
const assistant = (id, text, completed = 1) => ({
  id,
  type: "assistant",
  time: { completed },
  content: [{ type: "text", text }],
});
const idle = (outcome, id = "msg_idle", error) => ({ id, type: "idle", outcome, error });

async function withTimeline(pages, run) {
  let polls = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/api/session/ses_test/message");
    res.setHeader("content-type", "application/json");
    const page = pages[Math.min(polls++, pages.length - 1)];
    res.end(JSON.stringify({ data: page, cursor: {} }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`, () => polls);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("v2 waits through stale idle, completed tool steps and streaming final answer", async () => {
  const stale = [idle("failed", "msg_old_idle"), assistant("msg_old", "old reply")];
  const tool = assistant("msg_tool", "working");
  tool.finish = "tool-calls";
  const final = assistant("msg_final", "final answer");
  await withTimeline(
    [
      [user, ...stale],
      [tool, user, ...stale],
      [{ ...assistant("msg_final", "partial"), time: {} }, tool, user, ...stale],
      [idle("succeeded"), final, tool, user, ...stale],
    ],
    async (base, polls) => {
      const result = await api.waitForCompletion(base, "ses_test", user.id, { timeoutMs: 2000 });
      assert.equal(polls(), 4);
      assert.equal(result.id, "msg_final");
      assert.equal(result.content[0].text, "final answer");
    },
  );
});

test("v2 selects the first terminal after admission, not a newer turn's final answer", async () => {
  await withTimeline(
    [
      [
        idle("succeeded", "msg_later_idle"),
        assistant("msg_later", "wrong turn"),
        { id: "msg_later_user", type: "user" },
        idle("succeeded"),
        assistant("msg_final", "correct turn"),
        user,
      ],
    ],
    async (base, polls) => {
      const result = await api.waitForCompletion(base, "ses_test", user.id, { timeoutMs: 1000 });
      assert.equal(result.content[0].text, "correct turn");
      assert.equal(polls(), 1);
    },
  );
});

for (const outcome of ["failed", "interrupted"]) {
  test(`v2 ${outcome} terminal rejects partial text and cannot become late success`, async () => {
    await withTimeline(
      [
        [idle(outcome), assistant("msg_partial", "not a success"), user],
        [idle("succeeded"), assistant("msg_late", "late success"), user],
      ],
      async (base, polls) => {
        await assert.rejects(
          api.waitForCompletion(base, "ses_test", user.id, { timeoutMs: 1000 }),
          outcome === "failed" ? /execution failed/ : /MessageAbortedError: message aborted/,
        );
        assert.equal(polls(), 1);
      },
    );
  });
}

test("v2 idle failure without an assistant sanitizes structured provider errors", async () => {
  await withTimeline(
    [[idle("failed", "msg_idle", { type: "APIError", status: 401, message: "private" }), user]],
    async (base, polls) => {
      await assert.rejects(
        api.waitForCompletion(base, "ses_test", user.id, { timeoutMs: 1000 }),
        (error) => error.message === "APIError: provider authentication failed",
      );
      assert.equal(polls(), 1);
    },
  );
});

for (const page of [
  [idle("succeeded"), assistant("msg_final", "unanchored")],
  [assistant("msg_tool", "intermediate"), user, idle("succeeded", "msg_old_idle")],
  [idle("succeeded"), assistant("msg_final", "wrong anchor"), { ...user, type: "synthetic" }],
]) {
  test(`v2 does not finish without a user-anchored terminal: ${page[0].id}/${page.at(-1).type}`, async () => {
    await withTimeline([page], async (base, polls) => {
      await assert.rejects(
        api.waitForCompletion(base, "ses_test", user.id, { timeoutMs: 100 }),
        /did not complete within 100ms/,
      );
      assert.equal(polls(), 1);
    });
  });
}

for (const page of [
  [idle("unexpected"), user],
  [idle("succeeded"), user],
  [idle("succeeded"), { ...assistant("msg_final", "incomplete"), time: {} }, user],
]) {
  test(`v2 rejects malformed terminal success: ${page[0].outcome}/${page.length}`, async () => {
    await withTimeline([page], async (base, polls) => {
      await assert.rejects(
        api.waitForCompletion(base, "ses_test", user.id, { timeoutMs: 1000 }),
        /unexpected outcome|no completed assistant/,
      );
      assert.equal(polls(), 1);
    });
  });
}

test("v2 success may have empty final text and ignores an older assistant step error", async () => {
  const final = { ...assistant("msg_final", ""), content: [] };
  const retried = { ...assistant("msg_retry", ""), error: { type: "UnknownError" } };
  await withTimeline([[idle("succeeded"), final, retried, user]], async (base, polls) => {
    const result = await api.waitForCompletion(base, "ses_test", user.id, { timeoutMs: 1000 });
    assert.deepEqual(result.content, []);
    assert.equal(result.id, "msg_final");
    assert.equal(polls(), 1);
  });
});

test("v2 invalid admission fails before making a request", async () => {
  await withTimeline([[]], async (base, polls) => {
    await assert.rejects(
      api.waitForCompletion(base, "ses_test", undefined, { timeoutMs: 1000 }),
      /admission returned an unexpected message ID/,
    );
    assert.equal(polls(), 0);
  });
});
