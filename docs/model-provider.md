# Model provider foundation

Issues #67 and #68 supply a reusable `model-provider` config node and a
CommonJS-to-ESM adapter for trusted execution nodes. No HTTP endpoint exposes
credentials. This foundation does not add model or decision execution nodes.

## Configuration and credentials

The config node stores `name`, `provider` (`openrouter` or `gateway`), `baseURL`,
`decisionsBaseURL`, `defaultModel`, `allowedModels`, and `timeout` in the flow.
`apiKey` is declared as a native Node-RED **password credential** in both editor
and runtime. Configure a stable Node-RED `credentialSecret` for encrypted
credential storage. Flow exports omit the key; imports need separate credential
provisioning. No environment variable is changed or used in place of the key.

Timeout is an integer from 1 to 600000 milliseconds, default 60000. Allowed
models are exact IDs separated by commas or newlines. An omitted/blank model
selects `defaultModel`; a different ID must appear in `allowedModels`. There is
no model discovery or guarantee that an allowed model supports an operation.

Blank URLs use these defaults:

| Provider | Base URL | Decision URL |
| --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` | `https://openrouter.ai/api/alpha` |
| AI Gateway | `https://ai-gateway.vercel.sh/v4/ai` | Same base URL |

Custom URLs require administrator approval in Node-RED `settings.js`:

```js
nodeRedAgentsModelProvider: {
  allowedBaseURLs: [
    "https://proxy.example/api/v1",
    "https://proxy.example/api/alpha",
  ],
},
```

Approval matches the complete normalized base URL, not just its hostname.
URLs require HTTPS and cannot contain user info, query strings, or fragments.
OpenRouter replaces a trailing `/v1` with `/alpha`; that derived custom URL
also requires approval. Other custom routes require an explicit approved
`decisionsBaseURL`. Gateway rejects that field. HTTP redirects are rejected.
Messages cannot override credentials or URLs; consumers must not pass arbitrary
message headers, provider options, or SDK options through to the SDK.

## Pinned compatibility

| Package | Version | Module / Node requirement | Installed factories |
| --- | --- | --- | --- |
| `ai` | `7.0.138` | ESM / Node >=22 | `generateText`, `generateObject`, `embed`, `embedMany`, `experimental_decide` |
| `@ai-sdk/gateway` | `4.0.111` | ESM / Node >=22 | `createGateway`; `languageModel`, `embeddingModel`, `decisionModel` |
| `@openrouter/ai-sdk-provider` | `3.1.0` | ESM / Node >=22 | `createOpenRouter`; `languageModel`, `textEmbeddingModel`, `evaluationModel` |

The published package now requires Node >=22. CI uses `.nvmrc` (22).
Dynamic `import()` retains CommonJS Node-RED registration. OpenRouter 3.1.0
has **no `decisionModel` factory**: its v4 evaluation model has `doEvaluate`.
The installed `ai` SDK's decision resolver adapts this to `doDecide`; the
targeted tests invoke the actual `experimental_decide` implementation and both
provider packages against offline HTTP fixtures. They verify Boolean, Choice,
Score, exact routes, authentication, and request/response translation.
Documentation for newer OpenRouter versions must not replace this pinned contract.

`ai/test` exports `Experimental_DecisionMockModelV4` with `doDecide`, and the
legacy `Experimental_EvaluationMockModelV4` with `doEvaluate`. Decisions and
provider contracts are experimental: upgrade pins together and repeat tests.

## Exact consumer API

Require `packages/node-red-agents/shared/model-provider.js` (relative to a
consumer node, usually `../../shared/model-provider`). Exports:

| Export | Signature and return |
| --- | --- |
| `getProviderConfig` | `(RED, id) => config` (synchronous; trusted internal access including `apiKey` and config lifetime `signal`) |
| `loadSDK` | `() => Promise<typeof import("ai")>` |
| `createProvider` | `(RED, id, options = {}) => Promise<adapter>`; `options.fetch` is an optional trusted transport/test seam |
| `sanitizeResult` | `(result, secrets = []) => plainResult` |
| `safeError` | `(error) => ModelProviderError` |

`getProviderConfig` throws `MISSING_PROVIDER_CONFIG`,
`MISSING_PROVIDER_CREDENTIAL`, or `INVALID_PROVIDER_CONFIG`. Do not log or emit
its return value. The frozen adapter exposes:

- `sdk`, `provider`, `defaultModel`, `timeout` (no credential field).
- `createLanguageModel(requested?)`: synchronous language model instance.
- `createEmbeddingModel(requested?)`: synchronous embedding model instance.
- `createDecisionModel(requested?)`: synchronous v4 decision/evaluation model
  instance accepted by `sdk.experimental_decide`.
- `run(callback, { signal } = {}) => Promise<plainResult>`: callback receives
  `{ sdk, abortSignal, maxRetries: 0 }`. Pass these lifecycle options to the SDK.
- `sanitizeResult(result)`: credential-aware result projection.
- `safeError(error)`: sanitized error conversion.

```js
const { createProvider, safeError } = require("../../shared/model-provider");

// Resolve inside the request path so newly deployed credentials are used.
const adapter = await createProvider(RED, config.provider);
const result = await adapter.run(
  ({ sdk, ...lifecycle }) => sdk.generateText({
    model: adapter.createLanguageModel(),
    prompt: "Hello",
    ...lifecycle,
  }),
  { signal: controller.signal },
);
// Emit result, not raw SDK objects. Convert creation errors with safeError.
```

Use `sdk.embed({ model: adapter.createEmbeddingModel(id), value, ...lifecycle })`
for embedding, and `sdk.experimental_decide({ model:
adapter.createDecisionModel(id), state, questions, ...lifecycle })` for decisions.
Use model instances rather than SDK string model IDs (which resolve through the
global default provider). Do not mutate SDK globals or `process.env`.

Consumers own an AbortController for each active input and abort it on close.
The provider config node additionally aborts its lifetime signal on redeploy or
close: active runs cancel and old adapters reject subsequent runs. Timeout and
caller abort propagate to SDK fetch when lifecycle options are passed. `run`
also settles promptly if a callback ignores abort; it cannot stop arbitrary
callback side effects. Streaming results are outside this non-streaming API.

Safe results retain only `text`, `object`, `output`, `answers`, `rounding`,
`embedding`, `embeddings`, `usage`, `totalUsage`, `finishReason`, `warnings`,
`providerMetadata`, and `response`. Nested auth/header/body/request fields are
removed and known credential strings, encoded credentials, and Bearer tokens
are redacted. Model warnings are sanitized before SDK warning logging. Use
`adapter.run` rather than logging raw model/SDK results or exceptions.

Errors have `name: "ModelProviderError"`, a fixed safe message, and a code:
`INVALID_PROVIDER_CONFIG`, `MISSING_PROVIDER_CONFIG`,
`MISSING_PROVIDER_CREDENTIAL`, `REQUEST_TIMEOUT`, `REQUEST_ABORTED`,
`PROVIDER_AUTH` (401/403), `PROVIDER_RATE_LIMIT` (429), or `PROVIDER_ERROR`.
HTTP errors may include `statusCode`. Provider response bodies, original
messages, causes, and auth headers are not retained. Automatic retries are
disabled by the lifecycle options; downstream retry policies must be explicit.

## Verification and remaining live checklist

Run from the repository root:

```sh
node --test packages/node-red-agents/shared/test/model-provider.spec.js packages/node-red-agents/nodes/model-provider/test/model-provider.spec.js
make format
make lint
make test
```

The targeted suite checks Node-RED credential encryption/export/reload and
rotation, validation, SDK compatibility, 401/429/404/500, malformed responses,
network failure, timeout, caller cancellation, redeploy cancellation, and
redaction. HTTP fixtures prove SDK compatibility, not live provider availability.

Foundation verification: the targeted command above passed 24/24 tests under
Node v24.15.0 and Node v22.23.3. `make format` and `make lint` passed;
`make test` passed 328/328 tests with zero failures or skips. Node 22 reproduction:

```sh
npm exec --yes --package=node@22 -- node --test packages/node-red-agents/shared/test/model-provider.spec.js packages/node-red-agents/nodes/model-provider/test/model-provider.spec.js
```

After execution nodes integrate, use a separate disposable Node-RED userDir
and a verified free port for the live acceptance checklist:

1. Provision disposable keys separately for each provider; deploy and run text,
   embedding, and supported Jev Boolean/Choice/Score requests.
2. Check exported flows and flow storage contain no key; confirm credential
   storage is encrypted. Restart with the same secret and repeat a request.
3. Rotate the key and redeploy; new requests use the replacement. Export into a
   second userDir and verify it requires separate credential provisioning.
4. Verify invalid key/model, rate limit, timeout, abort, and unapproved URL
   failures through Catch/debug without credential leakage.

Live provider billing/authentication and disk-backed editor round trips remain
integration acceptance work; no real credentials are read by the offline suite.

References: [AI SDK Decisions](https://ai-sdk.dev/docs/ai-sdk-core/decisions),
[OpenRouter provider](https://github.com/OpenRouterTeam/ai-sdk-provider),
[Node-RED credentials](https://nodered.org/docs/creating-nodes/credentials),
[Lucide cog](https://lucide.dev/icons/cog). The icon's ISC attribution is shipped
beside its SVG.
