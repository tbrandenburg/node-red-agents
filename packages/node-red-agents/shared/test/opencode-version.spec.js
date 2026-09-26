"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseOpenCodeMajorVersion, detectOpenCodeMajorVersion } = require("../opencode-version");

test("parseOpenCodeMajorVersion reads plain and banner version strings", () => {
  assert.equal(parseOpenCodeMajorVersion("1.18.32"), 1);
  assert.equal(parseOpenCodeMajorVersion("OpenCode CLI\nopencode v2.0.18\n"), 2);
});

test("parseOpenCodeMajorVersion rejects empty, invalid, and unsupported versions", () => {
  assert.throws(() => parseOpenCodeMajorVersion(""), /could not parse/);
  assert.throws(() => parseOpenCodeMajorVersion("unknown"), /could not parse/);
  assert.throws(() => parseOpenCodeMajorVersion("3.0.0"), /unsupported.*3/);
});

test("detectOpenCodeMajorVersion invokes the selected binary with --version", () => {
  let invocation;
  const major = detectOpenCodeMajorVersion({
    binary: "/usr/bin/opencode",
    execFileSync(binary, args) {
      invocation = [binary, args];
      return "2.0.18";
    },
  });
  assert.equal(major, 2);
  assert.deepEqual(invocation, ["/usr/bin/opencode", ["--version"]]);
});

test("detectOpenCodeMajorVersion includes process output in failures", () => {
  assert.throws(
    () =>
      detectOpenCodeMajorVersion({
        execFileSync() {
          const error = new Error("spawn failed");
          error.stdout = "banner output";
          error.stderr = "bad cli";
          throw error;
        },
      }),
    /spawn failed.*banner output.*bad cli/,
  );
});
