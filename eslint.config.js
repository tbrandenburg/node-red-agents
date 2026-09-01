"use strict";

const js = require("@eslint/js");
const nodePlugin = require("eslint-plugin-n");
const prettierConfig = require("eslint-config-prettier");
const globals = require("globals");

module.exports = [
  {
    ignores: [
      "**/node_modules/**",
      "data/**",
      "demo/**",
      "docs/**",
      "**/coverage/**",
      "workspace/**",
    ],
  },
  js.configs.recommended,
  nodePlugin.configs["flat/recommended-script"],
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "n/no-unpublished-require": "off",
      "n/no-missing-require": "off",
    },
  },
  {
    files: ["**/*.spec.js", "test/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.mocha,
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    // CLI entry points: process.exit() after handling a fatal error is
    // idiomatic here, they target the repo's pinned Node version (see
    // .nvmrc) not the package's published `engines` range, and some are
    // executed directly (shebang required).
    files: ["scripts/**/*.js"],
    rules: {
      "n/no-process-exit": "off",
      "n/no-unsupported-features/node-builtins": "off",
      "n/hashbang": "off",
    },
  },
  {
    // Fixture is executed directly as a fake CLI, so the shebang is required
    files: ["**/fixtures/fake-opencode.js"],
    rules: {
      "n/hashbang": "off",
    },
  },
  {
    // Global fetch is experimental (not yet "stable") on Node 20, which
    // this package's engines.node (>=20) now targets, but it works fine in
    // practice: verified live under a real Node 20 runtime (see
    // tbrandenburg/cade#63 and node-red-agents#17), no --experimental-fetch
    // flag needed since Node 18.
    files: ["packages/node-red-agents/nodes/agent-server/lib/http.js"],
    rules: {
      "n/no-unsupported-features/node-builtins": "off",
    },
  },
  prettierConfig,
];
