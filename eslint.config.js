"use strict";

const js = require("@eslint/js");
const nodePlugin = require("eslint-plugin-n");
const prettierConfig = require("eslint-config-prettier");
const globals = require("globals");

module.exports = [
  {
    ignores: ["**/node_modules/**", "data/**", "demo/**", "docs/**", "**/coverage/**"],
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
    // idiomatic here, and they target the repo's pinned Node version (see
    // .nvmrc), not the package's published `engines` range.
    files: ["scripts/**/*.js"],
    rules: {
      "n/no-process-exit": "off",
      "n/no-unsupported-features/node-builtins": "off",
    },
  },
  {
    // Fixture is executed directly as a fake CLI, so the shebang is required
    files: ["**/fixtures/fake-opencode.js"],
    rules: {
      "n/hashbang": "off",
    },
  },
  prettierConfig,
];
