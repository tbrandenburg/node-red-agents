"use strict";

function invalid() {
  throw Object.assign(new Error("Invalid decision input: check state, questions and model"), {
    code: "INVALID_DECISION_INPUT",
  });
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function json(value, ancestors = new Set()) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if ((!record(value) && !Array.isArray(value)) || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid =
    Object.getOwnPropertySymbols(value).length === 0 &&
    (Array.isArray(value) ? Array.from(value) : Object.values(value)).every((item) =>
      json(item, ancestors),
    );
  ancestors.delete(value);
  return valid;
}

function description(value) {
  return (typeof value === "string" || record(value) || Array.isArray(value)) && json(value);
}

function named(name) {
  return (
    typeof name === "string" &&
    name.trim().length > 0 &&
    !["__proto__", "constructor", "prototype"].includes(name)
  );
}

function parse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return invalid();
  }
}

function validateOverride(override) {
  if (
    !record(override) ||
    Object.getOwnPropertySymbols(override).length ||
    Object.keys(override).some((key) => !["state", "questions", "model"].includes(key))
  )
    invalid();
}

function boolean(criteria) {
  if (criteria === undefined) return;
  if (
    !record(criteria) ||
    Object.keys(criteria).length !== 2 ||
    !Object.hasOwn(criteria, "true") ||
    !Object.hasOwn(criteria, "false") ||
    !Object.values(criteria).every(description)
  )
    invalid();
}

function choice(criteria) {
  if (
    !record(criteria) ||
    !Object.keys(criteria).length ||
    !Object.keys(criteria).every(named) ||
    !Object.values(criteria).every((value) => value === null || description(value))
  )
    invalid();
}

function score(criteria) {
  if (!Array.isArray(criteria) || criteria.length < 2 || !Array.from(criteria).every(description))
    invalid();
}

const validators = { boolean, choice, score };

function validateQuestion([name, question]) {
  if (
    !named(name) ||
    !record(question) ||
    !description(question.instructions) ||
    typeof question.type !== "string" ||
    !Object.hasOwn(validators, question.type) ||
    Object.keys(question).some((key) => !["type", "instructions", "criteria"].includes(key))
  )
    invalid();
  validators[question.type](question.criteria);
}

function request(config, msg) {
  const override = msg.decision === undefined ? {} : msg.decision;
  validateOverride(override);
  const state = Object.hasOwn(override, "state") ? override.state : parse(config.state);
  const questions = Object.hasOwn(override, "questions")
    ? override.questions
    : parse(config.questions);
  const model = Object.hasOwn(override, "model") ? override.model : config.model;
  if (!description(state) || (model !== undefined && typeof model !== "string")) invalid();
  if (!record(questions) || !Object.keys(questions).length || !json(questions)) invalid();
  Object.entries(questions).forEach(validateQuestion);
  // This node accepts JSON arrays as data, not SDK file parts or downloadable URLs.
  return {
    state: Array.isArray(state) ? [{ type: "json", value: state }] : state,
    questions,
    model,
  };
}

module.exports = { request };
