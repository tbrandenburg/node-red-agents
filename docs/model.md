# Model node

`model` makes direct AI SDK requests through a [model-provider](/docs/model-provider.md).
It uses the pinned AI SDK 7 contract and requires Node 22+. It does not spawn a
CLI, run tools, or select a fallback model.

## Configuration

| Field | Contract |
| --- | --- |
| Provider | Required `model-provider` config node; credentials remain in its native Node-RED credential store. |
| Operation | `generate`, `structured`, or `embed`. |
| Model | Optional model ID; blank inherits the provider default. `msg.model` overrides this field. The provider enforces exact allowlisted IDs. |
| Input mode | `prompt` for text, `messages` for an array of text-only `{role, content}` objects. Supported roles: `system`, `user`, `assistant`. |
| Input | Typed Node-RED property, default `msg.payload`; supports `str`, `msg`, `flow`, `global`, `json`, `jsonata`. |
| JSON schema | Structured operation only: strict draft-07 object schema, validated with existing Ajv. Unknown keywords, invalid schemas and unresolved references fail before the request. |
| Timeout | `0` inherits the provider timeout; `1`–`600000` ms imposes an additional deadline. The earlier deadline wins. |
| Streaming | Generate or structured only; embedding requires one non-empty text value. |

Credentials, URLs, headers, provider options and arbitrary SDK options in messages
are not accepted as request overrides. Messages mode projects only `role` and
`content`; multimodal uploads and tool messages are outside this node's contract.

## Outputs

Output **1 (Final result)** sends exactly one successful message with
`msg.modelResult`. It preserves the original payload and unrelated fields.

- Generate: `text`, plus available `usage`, `totalUsage`, `finishReason`,
  `warnings`, `providerMetadata`.
- Structured: those generation fields plus schema-validated `object`. Uses
  `generateText`/`streamText` with `sdk.Output.object({schema: sdk.jsonSchema(...)})`
  and an Ajv validation callback, not hand-parsed provider text.
- Embed: `embedding` (numeric vector) and available SDK metadata. Uses `sdk.embed`
  with a provider-created embedding model. Batch embedding is not supported.

Metadata is projected and sanitized by the shared adapter. Raw SDK objects,
request headers and response bodies are not emitted.

Output **2 (Stream events)** sends preserved copies of the input with:

```json
{"modelEvent":{"type":"text-delta","text":"safe streamed text"}}
```

The node consumes the entire SDK `fullStream`, including error events, before
sending the final message. Text deltas are sanitized, with a retained suffix to
protect credentials split across chunks. Short responses may be buffered until
completion; long unfinished Bearer tokens are retained until their delimiter.
Stream-start warnings are sanitized before SDK warning logging. Partial events
can precede a failed request, but failure never produces a final success.

## Errors and lifecycle

Use a native Catch node scoped to the model node. Invalid input/schema errors
have code `INVALID_MODEL_INPUT` and fixed validation messages. Provider errors
use the shared sanitized error contract (`PROVIDER_AUTH`, `PROVIDER_RATE_LIMIT`,
`PROVIDER_ERROR`, configuration errors, `REQUEST_TIMEOUT`, `REQUEST_ABORTED`).
Unsupported provider/model features fail through Catch rather than fabricating a
result. Automatic retries are disabled.

Each input resolves the provider afresh and owns an independent AbortController.
Closing/redeploying aborts active requests and blocks late events/results.
Provider lifetime cancellation and its timeout remain authoritative; a node
timeout can shorten but cannot extend that timeout.

## Importable example and live acceptance

Import [the example flow](/packages/node-red-agents/nodes/model/examples/model.json).
Provision its provider API key separately, set the default to a supported text
model, and put a real embedding model ID in both Allowed models and the embedding
node's Model field. The placeholder ID in the example is not a runnable model.
The generation and embedding operations may require different model IDs.

After package registration and integration, use a disposable Node-RED userDir and
an independently verified free port:

1. Generate a short response; inspect `modelResult.text` and preserved payload.
2. Run structured generation; inspect `modelResult.object.answer` as a string.
3. Embed sample text using a real embedding model; inspect a numeric vector.
4. Stream text; inspect text events and exactly one final message.
5. Try invalid key, disallowed/unsupported model and invalid schema. Check Catch
   and absence of final success, then redeploy mid-stream and check cancellation.

Live provider authentication/billing and editor round-trip E2E are unverified in
the offline node suite and remain coordinator acceptance work.

## Offline verification

```sh
node --test packages/node-red-agents/nodes/model/test/*.spec.js
make format
make lint
make test
```

Tests use actual installed SDK generation, structured output, embedding and
stream implementations with SDK offline model mocks; the Node-RED helper uses an
OS-assigned ephemeral port. They cover invalid schemas/outputs, override policy,
creation/auth/network/unsupported failures, full-stream errors, split-secret
redaction, timeout, close cancellation, concurrent requests and typed inputs.

References: [AI SDK generation](https://ai-sdk.dev/docs/ai-sdk-core/generating-text),
[structured output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data),
[Lucide brain](https://lucide.dev/icons/brain).
