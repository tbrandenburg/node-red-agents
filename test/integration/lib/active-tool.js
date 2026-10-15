"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

async function until(check, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return;
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("timed out waiting for real acceptance condition");
}

function running(pid) {
  const state = execFileSync("ps", ["-eo", "pid=,stat="], { encoding: "utf8", timeout: 1000 })
    .split("\n")
    .find((line) => Number(line.trim().split(/\s+/)[0]) === pid);
  return Boolean(state && !state.trim().split(/\s+/)[1].startsWith("Z"));
}

function toolPids(script) {
  // SRT exposes different PIDs. Match the disposable script's exact argv/title,
  // never a broad process name. A short title fits Linux's argv-backed limit.
  const title = `${process.execPath} ${path.basename(path.dirname(script)).slice(-6)}`;
  return execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 1000 })
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      return match &&
        (match[2] === title ||
          (match[2].startsWith(`${process.execPath} `) && match[2].includes(script)))
        ? [Number(match[1])]
        : [];
    });
}

function descendants(parent) {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 1000 })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const owned = new Set([parent]);
  for (let size = 0; size !== owned.size;) {
    size = owned.size;
    rows.filter(([, ppid]) => owned.has(ppid)).forEach(([pid]) => owned.add(pid));
  }
  owned.delete(parent);
  return [...owned];
}

function activeTool(dir) {
  const active = path.join(dir, "active.json");
  const late = path.join(dir, "late-success");
  const script = path.join(dir, "active.js");
  fs.writeFileSync(
    script,
    `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    process.title = ${JSON.stringify(`${process.execPath} ${path.basename(dir).slice(-6)}`)};
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(script)}], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(active)}, JSON.stringify([process.pid, child.pid]));
    setTimeout(() => { fs.writeFileSync(${JSON.stringify(late)}, 'late'); child.kill(); }, 45000);
  `,
  );
  const prompt = `Use the native shell tool directly (not execute/Code Mode and not search) to execute exactly: ${process.execPath} ./active.js. Use the current working directory. Run in the foreground with timeout 60000, background false. Await the shell tool. Do not read/edit files or use other tools. Only after the command completes reply LATE_SUCCESS.`;
  return { active, late, script, prompt };
}

module.exports = { until, running, toolPids, activeTool, descendants };
