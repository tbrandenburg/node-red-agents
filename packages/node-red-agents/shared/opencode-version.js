"use strict";

const { execFileSync: defaultExecFileSync } = require("child_process");

function parseOpenCodeMajorVersion(versionString) {
  const match = String(versionString || "").match(/(?:^|\s)v?(\d+)\./m);
  if (!match) throw new Error(`could not parse OpenCode version: ${String(versionString)}`);
  const major = Number(match[1]);
  if (major !== 1 && major !== 2) {
    throw new Error(`unsupported OpenCode CLI major version ${major}`);
  }
  return major;
}

function detectOpenCodeMajorVersion({
  binary = "opencode",
  execFileSync = defaultExecFileSync,
} = {}) {
  let stdout = "";
  try {
    stdout = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseOpenCodeMajorVersion(stdout);
  } catch (err) {
    const errorStdout = err && err.stdout ? String(err.stdout) : "";
    const stderr = err && err.stderr ? String(err.stderr) : "";
    const output = [String(stdout).trim(), errorStdout.trim(), stderr.trim()]
      .filter(Boolean)
      .join("; ");
    throw new Error(
      `failed to detect OpenCode CLI version using ${binary}: ${err.message}${output ? ` (output: ${output})` : ""}`,
      { cause: err },
    );
  }
}

module.exports = { parseOpenCodeMajorVersion, detectOpenCodeMajorVersion };
