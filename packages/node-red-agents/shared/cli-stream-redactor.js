"use strict";

// Only logical OpenCode text/reasoning is joined; tool and lifecycle events retain their shape.
function createEventRedactor(sanitize, variants, emit) {
  const pending = [];
  const pattern = variants.length
    ? new RegExp(
        variants.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
        "g",
      )
    : undefined;
  function output(entry, text) {
    emit(
      sanitize({
        ...entry.event,
        data: { ...entry.event.data, part: { ...entry.event.data.part, text } },
      }),
      entry.event,
    );
  }
  function flush(final = false) {
    let text = pending.map((entry) => entry.text).join("");
    // Apply matches backwards so offsets remain valid and replacements are never re-matched.
    for (const match of pattern ? [...text.matchAll(pattern)].reverse() : []) {
      const start = match.index;
      const end = start + match[0].length;
      let offset = 0;
      for (const entry of pending) {
        const length = entry.text.length;
        if (offset < end && offset + length > start) {
          entry.text =
            entry.text.slice(0, Math.max(0, start - offset)) +
            (offset <= start ? "[REDACTED]" : "") +
            entry.text.slice(Math.max(0, end - offset));
        }
        offset += length;
      }
    }
    text = pending.map((entry) => entry.text).join("");
    // Hold only a possible credential prefix, bounded by the longest known variant.
    let retained = 0;
    if (!final) {
      for (const variant of variants) {
        for (let size = Math.min(text.length, variant.length - 1); size > retained; size--) {
          if (text.endsWith(variant.slice(0, size))) {
            retained = size;
            break;
          }
        }
      }
    }
    let available = text.length - retained;
    while (pending.length && (available > 0 || !pending[0].text)) {
      const entry = pending[0];
      const length = Math.min(available, entry.text.length);
      output(entry, entry.text.slice(0, length));
      entry.text = entry.text.slice(length);
      available -= length;
      if (!entry.text) pending.shift();
    }
  }
  return {
    push(event) {
      if (!event) return;
      if (
        ["text", "reasoning"].includes(event.data?.type) &&
        typeof event.data?.part?.text === "string"
      ) {
        // Remove the original text from retained metadata so raw fragments have one owner.
        pending.push({
          event: { ...event, data: { ...event.data, part: { ...event.data.part, text: "" } } },
          text: event.data.part.text,
        });
        flush();
        return;
      }
      emit(sanitize(event));
    },
    flush: () => flush(true),
  };
}

module.exports = { createEventRedactor };
