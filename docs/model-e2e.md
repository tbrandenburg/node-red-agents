# Live shared-provider E2E (#66, #67–71)

This opt-in suite runs the installed package in a **real, separate Node-RED
process** with disposable disk-backed userDirs. It invokes the installed AI SDK
and provider packages over the public provider network. There are no HTTP,
SDK, model, CLI, or Node-RED mocks and no test-helper runtime.

## Run

Provision `OPENROUTER_API_KEY` in the invoking environment without putting it
in a command argument. The key must permit the chosen models and have credit.
From the isolated worktree:

```sh
npm ci
E2E_MODEL_LIVE=1 node --test --test-timeout=590000 test/integration/model-provider.spec.js
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
- Run the existing default OpenCode smoke model (`opencode/big-pickle`) with
  omitted new auth fields, then independently run `agent` with shared-provider
  authentication and blank model selection. The two subtests report independently.

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
Node-RED child starts without inherited API keys/tokens/secrets. Shared CLI auth
must therefore resolve the native credential rather than use an ambient key.
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
This test isolates those sources but does not prove a provider-side billed account
or daemon credential rotation. It exercises the direct OpenCode v1 adapter;
other CLI adapters and agent-server are outside this focused live pass.

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

Final live command above completed in 73.02 seconds under Node v24.15.0 and
OpenCode v1.18.35: **9 passed, 3 failed, 1 skipped** in Node's nested test count.
There is **one failing leaf scenario** (default OpenCode smoke); the other two
failures are its enclosing tests. Nine leaf scenarios passed; Gateway alone was
skipped with its missing-key reason. This acceptance suite is **not green**.

Observed external blocker: the prior default `opencode/big-pickle` smoke
returns `APIError`: “OpenCode's free tier can only be used from within OpenCode.”
This is a failed default-provider acceptance case; the independent authenticated
OpenRouter shared-provider CLI case has succeeded. Gateway is unverified when
its key is absent.

During harness development, reusing a Catch node while replacing a model node
with a decision node produced a Node-RED routing error (“Cannot read properties
of undefined (reading 'wires')”) and lost a synchronous Catch result. A fresh
runtime reproduced the intended `INVALID_DECISION_INPUT` Catch result. Malformed
cases now use independent runtimes to avoid this redeployment interaction; no
runtime implementation was changed. The suite is intentionally red if a genuine
provider/model acceptance scenario fails.
