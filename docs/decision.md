# Decision node

`decision` uses a shared `model-provider` config and the pinned AI SDK's
`experimental_decide`. It preserves the original message and adds
`msg.decisionResult`. It has one input and one output; routing and human review
are flow policy.

## Inputs

Select a provider, optionally choose an allowed model ID, and enter State JSON
and Questions JSON. Blank model uses the provider's default. State is a JSON
string, object or data array. Arrays are wrapped in an SDK JSON state part;
this MVP does not accept multimodal/file parts or download state URLs.
Message overrides are parsed values:

```js
msg.decision = {
  state: { message: "I was charged twice. Please refund the duplicate." },
  questions: {
    refund: {
      type: "boolean",
      instructions: "Is the customer requesting a refund?",
      criteria: { true: "Refund requested", false: "No refund requested" },
    },
    department: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: { billing: "Charges and refunds", support: "Technical help", other: null },
    },
    severity: {
      type: "score",
      instructions: "How severe is the issue?",
      criteria: ["Cosmetic", "Workaround exists", "Blocking; no workaround"],
    },
  },
};
```

Only `state`, `questions`, and `model` are accepted in `msg.decision`. Unknown
fields (including credentials, URLs, headers and provider options) fail before
provider creation. Questions must be a nonempty map with nonblank names and
`boolean`, `choice`, or `score` types. Instructions and descriptions accept
JSON-compatible strings, objects and arrays. Boolean criteria are optional,
but if supplied must contain both nonnull `true` and `false` descriptions.
Choice criteria require nonblank labels; null descriptions are allowed for a
catch-all option. Score criteria require at least two nonnull ordered levels,
indexed from zero. Extra question options are rejected. Cycles, class instances,
undefined values and nonfinite numbers fail validation before a model call.

## Output and errors

`decisionResult.answers` retains named typed answers:

- Boolean: `{ type: "boolean", probability: 0.8 }`, meaning P(true).
- Choice: `{ type: "choice", choice: "billing", probabilities?: { ... } }`.
- Score: `{ type: "score", score: 1.25, probabilities?: { "0": ..., "1": ... } }`.

The actual SDK validates missing answers, types, ranges, selected labels,
distribution sums and weighted scores. Invalid results produce an error, with
no success output. Rounding tolerances come from SDK `rounding`; returned values
are unchanged even if rounded probabilities sum to 0.99. No normalization or
conversion to binary truth occurs.

Available `rounding`, `usage`, `warnings`, `providerMetadata` and sanitized
`response` are retained by the shared adapter. Optional distributions, confidence,
cost and token counts are not invented. Provider-specific confidence/cost may
appear in metadata and are not a portable probability measure. Secret-bearing
metadata, request bodies and headers are removed/redacted by the shared adapter.
Attach a Catch node for fixed safe errors: local invalid input uses
`INVALID_DECISION_INPUT`; provider/auth/timeout/cancellation codes follow the
[shared provider contract](/docs/model-provider.md). Retries are disabled.
Closing/redeploying the node aborts its own controller for each active input.

## Importable example: decision → Switch → interaction

Import
[`review-refund.json`](/packages/node-red-agents/nodes/decision/examples/review-refund.json)
using the editor's Import dialog. Configure the example OpenRouter provider's
credential separately, deploy, then inject the ticket. The model ID is
`typesafe/jev-1.13`; Gateway users can select a Gateway config with
`typesafe-ai/jev`, subject to actual provider availability.

This example **explicitly chooses 0.8** for P(refund requested): the Switch sends
`>= 0.8` to the refund queue debug node and otherwise to interaction. This is a
demonstration threshold, not a calibration guarantee or automatic financial
approval. Adjust it using labeled task data. The review Request output is
visible in debug; copy its `interaction.id` into the response Inject's
`msg.interaction` JSON, select `approve` or `reject`, and inject into the same
interaction node. Continue emits the original context plus the human decision.
The unchanged pending Request must not be wired back to the interaction input.

## Compatibility and verification

Research uses the [official Decisions documentation](https://ai-sdk.dev/docs/ai-sdk-core/decisions)
and installed source for `ai@7.0.138`, `@ai-sdk/gateway@4.0.111`, and
`@openrouter/ai-sdk-provider@3.1.0`. Context7 currently includes older evaluation
terminology; the pinned implementation is authoritative. OpenRouter exposes
`evaluationModel/doEvaluate`, adapted by this SDK; Gateway exposes
`decisionModel/doDecide`. Runtime uses only shared `createDecisionModel` and
`run`, without renaming provider methods or changing SDK globals.

Offline tests execute the actual pinned SDK and both provider packages against
HTTP fixtures, covering the three question types, rounding, missing/invalid
results, invalid input, disallowed model IDs, HTTP/network errors, timeout and
concurrent close cancellation:

```sh
node --test packages/node-red-agents/nodes/decision/test/*.spec.js
make format
make lint
make test
```

OpenRouter live acceptance passed on 2026-10-13: the real Node-RED `decision`
node executed Jev `typesafe/jev-1.13` Boolean, Choice and Score questions through
the pinned SDK. See [live commands and evidence](/docs/model-e2e.md).
The Switch/interaction example is covered by node-level integration tests.

Authenticated Gateway Jev acceptance and browser editor round-trip remain
unverified; tracked in [#82](https://github.com/tbrandenburg/node-red-agents/issues/82).
Use a disposable userDir, check free ports, and provision credentials separately.
Do not include credentials in exported flows, debug messages or test evidence.
