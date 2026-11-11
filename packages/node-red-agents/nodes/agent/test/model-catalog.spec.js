"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const {
  refresh,
  project,
  dateKey,
  UpstreamError,
} = require("../../../../../scripts/model-catalog.js");

const source = {
  z: {
    name: "Z <script>\u2028",
    models: {
      "nested/b": { id: "nested/b", release_date: "2026-03-02", status: "deprecated" },
      "nested/a": { id: "nested/a", release_date: "2026-03-02", status: "alpha" },
      month: { id: "month", release_date: "2026-03" },
      bad: { id: "bad", release_date: "2026-02-31" },
      missing: { id: "missing" },
      "</script><img src=x>": { id: "</script><img src=x>", release_date: "2027-01-01" },
    },
  },
  a: {
    name: "A",
    models: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `alias${i}`,
        { id: `alias${i}`, release_date: "2025-01-01" },
      ]),
    ),
  },
};
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "agent.html");
  const input = path.join(dir, "input.json");
  await fs.writeFile(
    target,
    "<script>\n    // BEGIN MODEL CATALOG\n    const MODEL_CATALOG = {};\n    // END MODEL CATALOG\n</script>",
  );
  await fs.writeFile(input, JSON.stringify(source));
  return { target, input };
}

test("ranks provider-scoped aliases, dates and statuses without filtering", () => {
  const result = project(source, "2026-11-10");
  assert.deepEqual(
    result.providers.map((p) => p[0]),
    ["a", "z"],
  );
  assert.equal(result.providers[0][2].length, 10);
  assert.deepEqual(
    result.providers[1][2].map((m) => m[0]),
    ["</script><img src=x>", "nested/a", "nested/b", "month", "bad", "missing"],
  );
  assert.equal(dateKey("2026-02-31"), "");
  assert.equal(dateKey("2026-02-00"), "");
  assert.equal(dateKey("2026-02"), "2026-02-00");
  assert.equal(dateKey("2024-02-29"), "2024-02-29");
});

test("keeps chat capabilities and statuses while filtering high-confidence specialized models", () => {
  const models = {
    "fastino/GLiNER-2.5-Decide": {
      id: "fastino/GLiNER-2.5-Decide",
      type: "chat",
      description:
        "Classification-tuned GLiNER2 large. Entities, relations, and JSON extraction still work.",
      release_date: "2028-01-01",
    },
    "fastino/gliner2-multi-v1": {
      id: "fastino/gliner2-multi-v1",
      description: "Multilingual NER for cross-lingual extraction.",
      release_date: "2028-01-01",
    },
    "brick-complexity-pro": {
      id: "brick-complexity-pro",
      description:
        "Complexity classifier that powers the Brick semantic router by extracting query difficulty",
      release_date: "2028-01-01",
    },
    "nomic-embed-text": {
      id: "nomic-embed-text",
      description:
        "Embedding model for semantic search, retrieval, clustering, and ranking pipelines",
      release_date: "2028-01-01",
    },
    "embedding-only": {
      id: "embedding-only",
      description: "Embedding-only model for semantic search.",
      release_date: "2028-01-01",
    },
    typed: { id: "typed", type: "embedding", release_date: "2028-01-01" },
    decision: { id: "decision", type: "decision", release_date: "2028-01-01" },
    alpha: { id: "alpha", type: "chat", status: "alpha", release_date: "2027-01-01" },
    beta: { id: "beta", status: "beta", release_date: "2026-03-01" },
    deprecated: { id: "deprecated", status: "deprecated", release_date: "2026-02-00" },
    month: { id: "month", release_date: "2026-02" },
    future: { id: "future", status: "future-status", release_date: "2029-01-01" },
    "chat/ner": {
      id: "chat/ner",
      type: "chat",
      description: "General chat model supports NER, named entity recognition and span extraction.",
    },
    "chat/embeddings": {
      id: "chat/embeddings",
      description: "A chat and embedding model for classification and semantic search.",
    },
    "chat/null-type": { id: "chat/null-type", type: null },
    "chat/missing-type": { id: "chat/missing-type" },
  };
  const result = project({ p: { name: "P", models } }, "2026-11-10");
  assert.deepEqual(result.providers[0][2], [
    ["future", "2029-01-01"],
    ["alpha", "2027-01-01"],
    ["beta", "2026-03-01"],
    ["month", "2026-02"],
    ["chat/embeddings", ""],
    ["chat/missing-type", ""],
    ["chat/ner", ""],
    ["chat/null-type", ""],
    ["deprecated", "2026-02-00"],
  ]);
  assert.throws(
    () => project({ p: { name: "P", models: { typed: models.typed } } }, "2026-11-10"),
    /no models/,
  );
});

test("refresh writes deterministic safely escaped data; failed input preserves prior bytes", async (t) => {
  const files = await fixture(t);
  const options = { ...files, date: "2026-11-10" };
  await refresh(options);
  const original = await fs.readFile(files.target, "utf8");
  assert.ok(original.includes("\\u003c/script>"));
  assert.ok(original.includes("\\u2028"));
  await refresh(options);
  assert.equal(await fs.readFile(files.target, "utf8"), original);
  await fs.writeFile(files.input, "{}");
  await assert.rejects(refresh(options), /no models/);
  assert.equal(await fs.readFile(files.target, "utf8"), original);
  const stale = await refresh({ ...options, fallback: true });
  assert.equal(stale.retrieved, "2026-11-10");
  assert.equal(await fs.readFile(files.target, "utf8"), original);
  await fs.writeFile(
    files.target,
    original.replace("// END MODEL CATALOG", "// END MODEL CATALOG\n    // END MODEL CATALOG"),
  );
  await assert.rejects(refresh({ ...options, fallback: true }), /marker pair/);
});

test("marker text in serialized provider and model data survives refresh and fallback", async (t) => {
  const files = await fixture(t);
  const id = "provider    // BEGIN MODEL CATALOG\n    // END MODEL CATALOG";
  const model = "model    // END MODEL CATALOG";
  const data = {
    [id]: {
      name: "name    // BEGIN MODEL CATALOG\u2028    // END MODEL CATALOG",
      models: { [model]: { id: model } },
    },
  };
  await fs.writeFile(files.input, JSON.stringify(data));
  const options = { ...files, date: "2026-11-10" };
  const first = await refresh(options);
  assert.deepEqual(first.providers, [[id, data[id].name, [[model, ""]]]]);
  const original = await fs.readFile(files.target, "utf8");
  assert.ok(original.includes("\\u2028"));
  assert.deepEqual(await refresh(options), first);
  assert.equal(await fs.readFile(files.target, "utf8"), original);
  await fs.writeFile(files.input, "{}");
  assert.deepEqual(await refresh({ ...options, fallback: true }), first);
  assert.equal(await fs.readFile(files.target, "utf8"), original);
  for (const marker of ["BEGIN", "END"]) {
    const invalid = original.replace(
      `    // ${marker} MODEL CATALOG\n`,
      `    // ${marker} MODEL CATALOG\n    // ${marker} MODEL CATALOG\n`,
    );
    await fs.writeFile(files.target, invalid);
    await assert.rejects(refresh({ ...options, fallback: true }), /marker pair/);
    assert.equal(await fs.readFile(files.target, "utf8"), invalid);
  }
});

test("CRLF and mixed line endings permit refresh and preserve stale snapshot bytes at EOF", async (t) => {
  const files = await fixture(t);
  const id = "provider\r\n    // BEGIN MODEL CATALOG\r\n    // END MODEL CATALOG";
  const data = { [id]: { name: id, models: { [id]: { id } } } };
  await fs.writeFile(files.input, JSON.stringify(data));
  const options = { ...files, date: "2026-11-10" };
  const snapshot = await refresh(options);
  assert.equal(snapshot.retrieved, "2026-11-10");
  const generated = await fs.readFile(files.target, "utf8");
  const block = generated.slice(
    generated.indexOf("    // BEGIN"),
    generated.indexOf("\n</script>"),
  );
  const variants = [
    block,
    block.replaceAll("\n", "\r\n"),
    block.replace("\n", "\r\n").replace(";\n", ";\r\n"),
  ];
  for (const original of variants) {
    await fs.writeFile(files.target, original);
    await fs.writeFile(files.input, "{}");
    assert.deepEqual(await refresh({ ...options, fallback: true, date: "2026-11-11" }), snapshot);
    assert.equal(await fs.readFile(files.target, "utf8"), original);
    await fs.writeFile(files.input, JSON.stringify(data));
    assert.deepEqual(await refresh(options), snapshot);
    const updated = await fs.readFile(files.target, "utf8");
    const newline = original.startsWith("    // BEGIN MODEL CATALOG\r\n") ? "\r\n" : "\n";
    assert.ok(updated.startsWith(`    // BEGIN MODEL CATALOG${newline}`));
    assert.ok(updated.endsWith("    // END MODEL CATALOG"));
    assert.deepEqual(await refresh(options), snapshot);
    assert.equal(await fs.readFile(files.target, "utf8"), updated);
  }
});

test("mixed line ending duplicate and malformed markers cannot refresh or fall back", async (t) => {
  const files = await fixture(t);
  const options = { ...files, date: "2026-11-10" };
  await refresh(options);
  const original = await fs.readFile(files.target, "utf8");
  const variants = [
    `    // BEGIN MODEL CATALOG\r\n${original}`,
    `${original}\r\n    // END MODEL CATALOG\r\n`,
    `${original}\r\n    // BEGIN MODEL CATALOG`,
    original
      .replace("    // BEGIN MODEL CATALOG\n", "    // BEGIN MODEL CATALOG\r\n")
      .replace("    // END MODEL CATALOG\n", "    // END MODEL CATALOG extra\n"),
  ];
  for (const invalid of variants) {
    await fs.writeFile(files.target, invalid);
    for (const input of [JSON.stringify(source), "{}"]) {
      await fs.writeFile(files.input, input);
      await assert.rejects(refresh({ ...options, fallback: true }), /marker pair/);
      assert.equal(await fs.readFile(files.target, "utf8"), invalid);
    }
  }
  const malformed = original.replace("    // prettier-ignore\n", "    // altered\r\n");
  await fs.writeFile(files.target, malformed);
  await fs.writeFile(files.input, "{}");
  await assert.rejects(refresh({ ...options, fallback: true }), /missing prior catalog snapshot/);
  assert.equal(await fs.readFile(files.target, "utf8"), malformed);
});

test("real HTTP redirects are HTTP failures and never reach their target", async (t) => {
  const files = await fixture(t);
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/untrusted" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(source));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (endpoint) => (_url, options) => fetch(`${base}/${endpoint}`, options);
  const initial = await fs.readFile(files.target, "utf8");
  await assert.rejects(
    refresh({ target: files.target, fallback: true, request: request("redirect") }),
    /prior catalog snapshot/,
  );
  assert.equal(await fs.readFile(files.target, "utf8"), initial);
  const snapshot = await refresh({
    target: files.target,
    request: request("success"),
    date: "2026-11-10",
  });
  const original = await fs.readFile(files.target, "utf8");
  await assert.rejects(
    refresh({ target: files.target, request: request("redirect") }),
    (error) => error instanceof UpstreamError && error.message === "HTTP 302",
  );
  assert.deepEqual(
    await refresh({ target: files.target, fallback: true, request: request("redirect") }),
    snapshot,
  );
  assert.equal(await fs.readFile(files.target, "utf8"), original);
  const invalid = original.replace('"retrieved":"2026-11-10"', '"retrieved":"2026-02-31"');
  assert.notEqual(invalid, original);
  await fs.writeFile(files.target, invalid);
  await assert.rejects(
    refresh({ target: files.target, fallback: true, request: request("redirect") }),
    /invalid prior catalog snapshot/,
  );
  assert.equal(await fs.readFile(files.target, "utf8"), invalid);
  assert.deepEqual(hits, ["/redirect", "/success", "/redirect", "/redirect", "/redirect"]);
});

test("atomic write failure preserves a validated snapshot and never falls back", async (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip("root bypasses directory write permissions");
    return;
  }
  const files = await fixture(t);
  await refresh({ ...files, date: "2026-11-10" });
  const before = await fs.readFile(files.target, "utf8");
  const dir = path.dirname(files.target);
  await fs.chmod(dir, 0o500);
  try {
    await assert.rejects(refresh({ ...files, fallback: true }), { code: "EACCES" });
    assert.equal(await fs.readFile(files.target, "utf8"), before);
  } finally {
    await fs.chmod(dir, 0o700);
  }
});

test("invalid, missing and oversized input cannot replace snapshot; invalid fallback fails", async (t) => {
  const files = await fixture(t);
  const initial = await fs.readFile(files.target, "utf8");
  await fs.writeFile(files.input, "not json");
  await assert.rejects(refresh(files), /invalid JSON/);
  await assert.rejects(refresh({ ...files, fallback: true }), /prior catalog snapshot/);
  await fs.writeFile(files.input, Buffer.alloc(12 * 1024 * 1024 + 1));
  await assert.rejects(refresh(files), /size limit/);
  await fs.unlink(files.input);
  await assert.rejects(refresh({ ...files, fallback: true }), /ENOENT/);
  assert.equal(await fs.readFile(files.target, "utf8"), initial);
});

test("real HTTP failure and timeout retain a validated snapshot", async (t) => {
  const files = await fixture(t);
  await refresh({ ...files, date: "2026-11-10" });
  const original = await fs.readFile(files.target, "utf8");
  const server = http.createServer((req, res) => {
    if (req.url === "/error") {
      res.writeHead(503);
      res.end();
    }
    if (req.url === "/body-timeout") {
      res.writeHead(200);
      res.write("{");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const endpoint of ["error", "timeout", "body-timeout"]) {
    const request = (_url, options) => fetch(`${base}/${endpoint}`, options);
    const result = await refresh({
      target: files.target,
      fallback: true,
      request,
      timeout: endpoint === "error" ? 2000 : 50,
    });
    assert.equal(result.retrieved, "2026-11-10");
    assert.equal(await fs.readFile(files.target, "utf8"), original);
  }
  await assert.rejects(
    refresh({ target: files.target, fallback: true, request: async () => ({}) }),
    /invalid fetch response/,
  );
  assert.equal(await fs.readFile(files.target, "utf8"), original);
});

test("programming TypeErrors in request and response stream never trigger fallback", async (t) => {
  const files = await fixture(t);
  await refresh({ ...files, date: "2026-11-10" });
  const original = await fs.readFile(files.target, "utf8");
  const bug = new TypeError("programming error");
  const requests = [
    async () => {
      throw bug;
    },
    async () => ({
      ok: true,
      headers: new Headers(),
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from("{");
          throw bug;
        },
      },
    }),
    async () => ({
      ok: true,
      headers: new Headers(),
      body: {
        async *[Symbol.asyncIterator]() {
          yield {};
        },
      },
    }),
  ];
  for (const request of requests) {
    await assert.rejects(refresh({ target: files.target, fallback: true, request }), TypeError);
    assert.equal(await fs.readFile(files.target, "utf8"), original);
  }
});

test("real connection refusal and truncated response retain the prior snapshot", async (t) => {
  const files = await fixture(t);
  await refresh({ ...files, date: "2026-11-10" });
  const original = await fs.readFile(files.target, "utf8");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-length": "100" });
    res.write("{");
    setTimeout(() => res.destroy(), 30);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  let received = false;
  const request = async (_url, options) => {
    const response = await fetch(`http://127.0.0.1:${port}/`, options);
    received = true;
    return response;
  };
  const truncated = await refresh({ target: files.target, fallback: true, request, timeout: 2000 });
  assert.equal(received, true);
  assert.equal(truncated.retrieved, "2026-11-10");
  await new Promise((resolve) => server.close(resolve));
  const refused = await refresh({ target: files.target, fallback: true, request, timeout: 2000 });
  assert.equal(refused.retrieved, "2026-11-10");
  assert.equal(await fs.readFile(files.target, "utf8"), original);
});
