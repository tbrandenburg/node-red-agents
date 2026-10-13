"use strict";

const { TransformStream } = require("node:stream/web");

// Retain suffixes so a credential or Bearer token split across chunks cannot leak.
function deltas(adapter, secret, emit) {
  const secrets = [secret, encodeURIComponent(secret)].filter(Boolean);
  const retained = Math.max(8, ...secrets.map((value) => value.length));
  let pending = "";
  return (text, final = false) => {
    pending += text;
    let end = final ? pending.length : Math.max(0, pending.length - retained);
    if (!final) {
      for (const value of secrets) {
        let index = pending.indexOf(value);
        while (index >= 0) {
          if (index < end && index + value.length > end) end = index;
          index = pending.indexOf(value, index + 1);
        }
      }
      for (const match of pending.matchAll(/\bBearer\s+[^\s,;"'}]*/gi)) {
        if (match.index < end && match.index + match[0].length >= end) end = match.index;
      }
    }
    if (!end) return;
    const safe = adapter.sanitizeResult({ text: pending.slice(0, end) }).text;
    pending = pending.slice(end);
    if (safe) emit({ type: "text-delta", text: safe });
  };
}

function languageModel(adapter, requested) {
  const model = adapter.createLanguageModel(requested);
  const wrapped = Object.create(model);
  // The foundation wraps doGenerate only; stream warnings must be safe before SDK logging.
  wrapped.doStream = async (options) => {
    const result = await model.doStream(options);
    return {
      ...result,
      warnings: adapter.sanitizeResult({ warnings: result.warnings || [] }).warnings,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(
              part.type === "stream-start"
                ? {
                    ...part,
                    warnings: adapter.sanitizeResult({ warnings: part.warnings || [] }).warnings,
                  }
                : part,
            );
          },
        }),
      ),
    };
  };
  return wrapped;
}

async function stream(adapter, options, structured, secret, emit) {
  const write = deltas(adapter, secret, emit);
  let failure;
  let finished = false;
  const result = adapter.sdk.streamText({
    ...options,
    onError: ({ error }) => {
      failure = adapter.safeError(error);
    },
    onAbort: () => {
      failure = adapter.safeError({ code: "REQUEST_ABORTED" });
    },
  });
  for await (const part of result.fullStream) {
    if (options.abortSignal.aborted) throw options.abortSignal.reason;
    if (part.type === "error") failure = adapter.safeError(part.error);
    if (part.type === "abort") failure = adapter.safeError({ code: "REQUEST_ABORTED" });
    if (part.type === "finish") finished = true;
    if (part.type === "text-delta" && !failure) write(part.text);
  }
  if (failure) throw failure;
  if (!finished) throw new Error("Model stream ended without completion");
  const projected = {
    text: await result.text,
    usage: await result.usage,
    totalUsage: await result.totalUsage,
    finishReason: await result.finishReason,
    warnings: await result.warnings,
    providerMetadata: await result.providerMetadata,
    ...(structured ? { object: await result.output } : {}),
  };
  if (projected.finishReason === "error") throw new Error("Model stream failed");
  write("", true);
  return projected;
}

module.exports = { stream, languageModel, deltas };
