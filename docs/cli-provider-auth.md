# CLI provider authentication

`agent` and `agent-server` optionally reuse native Node-RED password credentials
from a `model-provider` config node. See [the foundation contract](/docs/model-provider.md).
Flow configuration contains only `authMode` and the optional `modelProvider` node ID.
There are no plaintext environment-key fields in either editor.

## Modes

- **default** (including omitted fields in existing flows): preserve the CLI's
  existing login/config and inherited environment. Ignore `modelProvider` and do
  not change model selection. This also preserves Copilot OAuth behavior.
- **provider**: resolve `getProviderConfig` inside each launch, override only the
  mapped API-key variable in a fresh child environment, and select the shared
  default model when the node's Model is blank. A Model override must use the
  matching **CLI** prefix and its remaining upstream ID must equal `defaultModel`
  or appear in `allowedModels`. For example, shared `anthropic/claude-sonnet-4`
  becomes `openrouter/anthropic/claude-sonnet-4`. A mismatched CLI provider fails
  before launch rather than silently using another account/provider.
- **environment**: ignore `modelProvider` completely (a config node/key is not
  required). Require an explicit supported CLI `provider/model` and a nonblank
  mapped key in the Node-RED process environment. Copy the inherited environment;
  do not inject a shared key, remap variables, change the selected model, remove
  saved authentication, or force environment precedence. This is a validated
  ambient-key mode, **not** an environment-only authentication isolation mode.

Messages cannot override these modes or select another credential config node.
Missing credentials, unsupported combinations and model mismatches report errors.
Shared custom base URLs are rejected: the SDK URL is not automatically a compatible
CLI endpoint. This feature does not write CLI configuration or authentication files,
nor change `process.env`. Existing CLI configuration still controls CLI endpoints,
extensions, auxiliary models, and authentication behavior.

## Explicit mapping matrix

| CLI | Shared provider | CLI model prefix | Child API-key variable |
| --- | --- | --- | --- |
| OpenCode auto, v1, v2; agent-server v1/v2 | `openrouter` | `openrouter` | `OPENROUTER_API_KEY` |
| Explicit OpenCode v1; agent-server using v1 API | `gateway` | `vercel` | `AI_GATEWAY_API_KEY` |
| Pi | `openrouter` | `openrouter` | `OPENROUTER_API_KEY` |
| Pi | `gateway` | `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` |

Gateway for OpenCode auto/v2 is rejected by the agent adapter because its CLI
provider contract is not verified here. Agent-server can detect v1, but an explicit
`apiVersionMode=v1` is recommended for Gateway. A wrong version mode remains the
operator's responsibility. Copilot shared-provider and environment modes are
rejected; OpenRouter/Gateway keys are not GitHub tokens or Copilot BYOK settings.
Other provider enums and arbitrary environment mappings are unsupported.

Pi receives `--provider <prefix>` and `--model <complete-upstream-id>`; OpenCode
receives the full CLI-prefixed model. Direct and SRT runtimes pass the child env
through to the launched process. SRT daemon reachability remains subject to the
existing agent-server limitation documented in its editor help.

## Authentication precedence and research

Environment injection offers a key to the CLI; it does **not** guarantee the billed
account. Saved API keys, OAuth, configured API keys, plugins, model settings or an
existing OpenCode v2 managed server can take precedence. Use an independently
provisioned, isolated CLI profile for account-sensitive deployments. This feature
never reads or changes the user's saved credentials to enforce precedence.

Official documentation and sources consulted before implementation:

- [OpenCode v1 providers](https://opencode.ai/docs/providers/): login credentials
  live in its auth store; provider config can override options.
- [OpenCode v1.2.27 provider implementation](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/opencode/src/provider/provider.ts):
  environment loads first, stored API keys load afterward, provider options can
  supply the SDK key; the Gateway CLI provider ID is `vercel`.
- [Models.dev Gateway catalog mapping](https://github.com/anomalyco/models.dev/blob/dev/providers/vercel/provider.toml):
  OpenCode's `vercel` catalog provider explicitly declares `AI_GATEWAY_API_KEY`
  and the native `@ai-sdk/gateway` package.
- [OpenCode v2 providers](https://opencode.ai/v2/docs/providers/) and
  [provider accounts](https://opencode.ai/v2/docs/cli/providers/): OpenRouter uses
  `OPENROUTER_API_KEY`; saved accounts take precedence over environment connections.
- [Pi providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md),
  [model authentication](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md),
  and [v0.84.1 environment mappings](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/env-api-keys.ts):
  OpenRouter and `vercel-ai-gateway` use the variables above. Runtime `--api-key`,
  saved `auth.json`, and `models.json` keys may precede environment credentials.
  We deliberately do not pass keys in argv or use `--api-key` to override that policy.

Context7 corroborated the OpenCode and Pi mapping/precedence documentation.
CLI versions are externally installed; these mappings are not a CLI compatibility pin.

## Rotation and redaction

Agent credentials resolve after a queued execution acquires a slot and its start
observer acknowledges, immediately before adapter validation/build and runtime
execution. Every retry/reask resolves again. Credentials/environment are kept out
of the resolved input and observer input record. Existing children keep their
launch environment until exit.

Agent-server resolves a fresh credential immediately before daemon spawn, after
port allocation/version detection. Running daemons keep their original key. After
rotating the shared credential, send `msg.operation="terminate"` with each tracked
`sessionID`, then start messages **without** that ID, or redeploy agent-server to
close its tracked children. Provider-config redeploy alone does not update a running
daemon's environment. Reused sessions still validate the requested provider/model.

Known injected and inherited API-key/token/password/secret values and their URL,
JSON-escaped and Base64 representations are redacted from parsed child events,
stderr-derived errors, results, terminal observer records and daemon replies/history.
Application field names (including `token`, `secret`, `headers` and `password`)
are preserved; known credential values and Bearer tokens are redacted. Cyclic
application messages are cloned with their references intact; external diagnostics
are depth-bounded. Sanitizers retain old launch keys for daemon responses after
rotation. OpenCode text/reasoning events buffer possible known-credential prefixes
across parsed events before live emission, observer notification or final retention.
Safe text may be emitted in smaller events with the original structured metadata.
This protects the package's emitted data; CLI-owned files, external plugin logs and
arbitrary transformations outside the listed encodings are outside this guarantee.

## Verification

Offline reproduction (synthetic credentials only):

```sh
npm ci
node --test --test-timeout=15000 packages/node-red-agents/shared/test/cli-provider-auth.spec.js packages/node-red-agents/nodes/agent/test/execution/cli-provider-auth.spec.js packages/node-red-agents/nodes/agent/test/integration/cli-provider-auth.node-helper.spec.js packages/node-red-agents/nodes/agent-server/test/integration/cli-provider-auth.node-helper.spec.js
make format
make lint
make test
```

Tests exercise mode compatibility, supported/rejected mappings, model selection,
unchanged process environment, real child spawning, direct/SRT wrapper propagation,
queued credential rotation, observer/event/result/error redaction, daemon rotation
and node close/termination. The SRT auth test uses a deterministic subprocess wrapper
to check the runtime's argv/env path; it is not proof of a particular SRT installation.

Live CLI provider authentication and billing remain **unverified**. A separate
acceptance pass must use disposable credentials and isolated CLI profiles:

1. Check a free port before starting a disposable Node-RED runtime; preserve
   existing services and stop only captured PIDs from this acceptance pass.
2. Run default/no-config flows with preprovisioned OpenCode/Pi authentication,
   and verify unchanged Copilot OAuth without shared authentication.
3. Provision a shared OpenRouter key securely; run OpenCode and Pi, verify the
   intended provider/account in provider-side usage, and inspect sanitized outputs.
4. Repeat Gateway with Pi and explicit OpenCode v1. Check invalid combinations and
   mismatched models fail before launch without credential leakage.
5. Start agent-server, rotate its key, confirm a reused daemon retains the old
   credential, terminate it, and confirm a fresh daemon uses the new credential.
6. Verify exports contain references only; provision imported credentials separately.

Do not paste keys, full process environments or raw CLI auth-store contents into
test reports. Compare boolean invariants or synthetic-key digests instead.
