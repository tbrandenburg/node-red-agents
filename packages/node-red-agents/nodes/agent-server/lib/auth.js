"use strict";

const { randomBytes } = require("crypto");

function createDaemonAuth(version, { username, password } = {}) {
  if (version === "v2") {
    return {
      username: "opencode",
      password: password || randomBytes(32).toString("hex"),
    };
  }
  if (!username && !password) return {};
  return { username: username || "", password: password || "" };
}

module.exports = { createDaemonAuth };
