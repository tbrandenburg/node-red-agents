# Live shared-provider E2E (#66, #67–71)

This opt-in suite runs the installed package in a **real, separate Node-RED
process** with disposable disk-backed userDirs. It invokes the installed AI SDK
and provider packages over the public provider network. There are no HTTP,
SDK, model, CLI, or Node-RED mocks and no test-helper runtime.

## Run

Provision `OPENROUTER_API_KEY` in the invoking environment without putting it
in a command argument. The key must permit the chosen models and have credit.
From the repository root:

```sh
npm ci
E2E_MODEL_LIVE=1 node --test --test-timeout=590000 test/integration/model-provider.spec.js
# Equivalent supported Make target:
make test-model-e2e
```

The outer command runner needs a 600000 ms timeout. Without `E2E_MODEL_LIVE=1`,
the suite explicitly skips before starting a runtime or making billed requests:

```sh
node --test test/integration/model-provider.spec.js
```

Linux `ss`, Node 22+, installed workspace dependencies, outbound HTTPS, and
`opencode` on PATH are prerequisites. OpenCode absence is a failed acceptance
case. No fallback model is selected after an unsupported model/provider response.
`E2E_MODEL_TEXT` optionally selects a different text model; the default is
`openai/gpt-4.1-nano`. The embedding ID is `openai/text-embedding-3-small` and
the OpenRouter decision ID is `typesafe/jev-1.13`.

## Scenarios and billing boundaries

- Generate a short response, preserve the input, emit exactly one final result.
- Reject non-text input, malformed JSON schema, and empty decision questions
  through native Catch before **zero observed provider fetches**. Each malformed
  case uses a fresh runtime and a synthetic invalid credential.
- Produce a schema-bound structured object with `answer: "pong"`.
- Stream text deltas and one final result; joined deltas must equal final text.
  Observation includes a 350 ms terminal quiet window to catch duplicate results.
- Produce a finite numeric embedding vector from a real embedding request.
- Ask Jev Boolean/Choice/Score together in one short request, validate typed
  answers and bounded probabilities/scores using the runtime's actual SDK.
- Inspect native `/flows` export and `flows.json` for credential exclusion;
  inspect the encrypted `$` envelope in `flows_cred.json`; stop and restart with
  the same userDir/credential secret and successfully generate again.
- Import that export into a second userDir without credentials and require
  `MISSING_PROVIDER_CREDENTIAL`, no success, and zero provider fetches.
- Rotate through native credential deployment to a synthetic invalid key,
  require real HTTP 401/403 and `PROVIDER_AUTH` through Catch without leaks,
  restore the live key, and successfully generate again.
- Optional Gateway generation and three-question Jev acceptance run only when
  `AI_GATEWAY_API_KEY` exists, using `typesafe-ai/jev`. Missing Gateway credentials
  produce an explicit skip reason, never a passing provider result. These are
  two Gateway probes, not a complete duplication of the OpenRouter lifecycle suite.
- Run `agent` with omitted new auth fields and an explicitly selected
  `openrouter/openai/gpt-4.1-nano` model using inherited CLI authentication, then
  independently run shared-provider authentication with blank model selection.
  Separate isolated profiles prevent ambient credentials from proving shared auth.
- Run `agent-server` with shared credentials, terminate its session, redeploy with
  an invalid credential and require Catch with no final success, then restore the
  real credential and verify a new daemon/session returns a response.

Each SDK operation makes one short request; SDK retries are disabled by the
implementation. A successful OpenRouter pass makes eight SDK requests including
the intentionally invalid-key request. Three Jev types share one request. Initial
auth/generation failure stops subsequent scenarios. Provider requests have a
55000 ms deadline, observation has a 65000 ms deadline, admin requests have a
10000 ms deadline, and startup has a 30000 ms deadline. OpenCode receives one
short prompt per mode, denied tool permissions, and a 55000 ms execution deadline;
CLI-internal auxiliary requests remain controlled by the installed CLI.

## Credential, profile and process isolation

The parent consumes keys programmatically. It submits them only in native
Node-RED password credential provisioning via loopback Admin HTTP, not in flow
exports, assertion objects, command arguments, or CLI configuration. The
Node-RED child starts without inherited API keys/tokens/secrets except in the
explicit default-CLI-auth scenario, which inherits only the OpenRouter key.
Shared CLI auth must resolve the native credential rather than use an ambient key.
Observable debug traffic, flow/credential storage and runtime logs are checked
for plaintext, URL-encoded and Base64 credentials; failure reports carry only
safe errors and provider route/status diagnostics, never headers or raw bodies.

The focused launcher uses the package's actual `node-red.nodes` registration
via `nodesDir`. It uses the worktree's own `npm ci` installation without creating
dependency symlinks. It does not touch `data/`, `demo/`, or existing services.
`ss -H -ltn` runs before each runtime/CLI launch; Node-RED binds `127.0.0.1:0`
directly. OpenCode receives loopback hostname configuration (its config schema
rejects port zero). Teardown sends signals only to the captured Node-RED child,
waits for its exit, and removes the temporary directory. Node close owns its CLI
child cleanup. No process-name or command-pattern killing is used.

CLI HOME and XDG config/data/cache/state directories are disposable. Its cwd is
outside the repository, inherited `OPENCODE_*` settings are removed, and inline
config disables updates/sharing and denies tools. No user's saved auth store is
read or modified. In production, shared-provider environment injection does not
override saved account/config precedence; see [CLI provider auth](/docs/cli-provider-auth.md).
This test isolates those sources but does not prove a provider-side billed account.
It exercises the OpenCode v1 adapter and agent-server daemon credential rotation;
Pi and Copilot live account verification remain separate acceptance work.

## Scoped checks

```sh
./node_modules/.bin/prettier --ignore-path /dev/null --check test/integration/model-provider.spec.js test/integration/lib/model-live-instance.js docs/model-e2e.md
./node_modules/.bin/eslint test/integration/model-provider.spec.js test/integration/lib/model-live-instance.js
```

Official OpenRouter research confirms Jev 1.13 and the three-question public
contract: [Jev tutorial](https://openrouter.ai/docs/guides/community/jev-tutorial).
The pinned provider translation is validated by the live `decision` node, not
by replacing the SDK route with a manually written HTTP request. Profile isolation
uses [OpenCode configuration](https://opencode.ai/docs/config/).

## Acceptance evidence and blockers

Coordinator verification on **2026-10-13**, Node **v24.15.0**, OpenCode **v1.18.35**:

| Command | Result |
|---|---|
| `make format` | Passed |
| `make lint` | Passed |
| `make test` | 447 passed, 0 failed, 0 skipped |
| `E2E_OPENCODE_MODEL=openrouter/openai/gpt-4.1-nano make test-e2e` | 5 passed, 0 failed; one v2-only test skipped in v1 mode |
| `make test-model-e2e` | 13 passed, 0 failed; Gateway skipped because its key is absent |

Minimum-runtime validation under **Node v22.23.3** executed the shared-provider,
CLI-auth, model, decision and server-API suites: **85 passed, 0 failed, 0 skipped**.
No separate typecheck script is configured in this CommonJS project.
The live provider run completed in 100.58 seconds and verified daemon invalid-key
rotation produces Catch rather than false success. Listeners were checked before
service startup; final inspection found no remaining test service listeners.

Gateway remains unverified
without its key. The prior default `opencode/big-pickle` model returned `APIError`:
“OpenCode's free tier can only be used from within OpenCode”; tracked in
[#78](https://github.com/tbrandenburg/node-red-agents/issues/78). To run the existing
smoke suite locally against an authenticated model instead, use:

```sh
E2E_OPENCODE_MODEL=openrouter/openai/gpt-4.1-nano make test-e2e
```

This optional model selection preserves the existing CI smoke default and uses
the CLI's existing authentication; it never injects a shared-provider credential.

During harness development, reusing a Catch node while replacing a model node
with a decision node produced a Node-RED routing error (“Cannot read properties
of undefined (reading 'wires')”) and lost a synchronous Catch result. A fresh
runtime reproduced the intended `INVALID_DECISION_INPUT` Catch result. Malformed
cases now use independent runtimes to avoid this redeployment interaction; no
runtime implementation was changed. Tracked in
[#77](https://github.com/tbrandenburg/node-red-agents/issues/77).
The suite is intentionally red if a genuine
provider/model acceptance scenario fails.
