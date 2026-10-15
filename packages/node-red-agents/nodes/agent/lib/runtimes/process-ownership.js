"use strict";

const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

function linuxIdentity(pid, read = readFileSync) {
  try {
    const stat = read(`/proc/${pid}/stat`, "utf8");
    // comm may contain spaces and parentheses; fields after its final ')' are fixed.
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    if (fields.length < 20 || !/^\d+$/.test(fields[19]))
      throw new Error("Invalid process identity");
    return { pid, parent: Number(fields[1]), group: Number(fields[2]), started: fields[19] };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}

function processTable() {
  return execFileSync("ps", ["-eo", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 4 * 1024 * 1024,
  })
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, parent, group, ...started] = line.trim().split(/\s+/);
      if (process.platform === "linux") {
        const identity = linuxIdentity(Number(pid));
        return identity ? [identity] : [];
      }
      return [
        {
          pid: Number(pid),
          parent: Number(parent),
          group: Number(group),
          started: started.join(" "),
        },
      ];
    });
}

function ownedDescendants(pid, table) {
  const owned = new Set([pid]);
  let size;
  do {
    size = owned.size;
    for (const row of table) if (owned.has(row.parent)) owned.add(row.pid);
  } while (size !== owned.size);
  return table.filter((row) => row.pid !== pid && owned.has(row.pid));
}

function signalOwned(owned, group, table, signal = process.kill) {
  const verified = owned.flatMap((row) => {
    const live = table.find((entry) => entry.pid === row.pid && entry.started === row.started);
    return live && row.started ? [live] : [];
  });
  // An exited leader's PID is not ownership evidence. A surviving owned member
  // must still belong to the original group before signalling its negative PGID.
  const groupOwned = verified.some((row) => row.group === group);
  const targets = [
    ...(groupOwned ? [-group] : []),
    ...verified.filter((row) => !groupOwned || row.group !== group).map((row) => row.pid),
  ];
  for (const pid of targets) {
    try {
      signal(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

module.exports = { linuxIdentity, processTable, ownedDescendants, signalOwned };
