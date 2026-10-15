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
# Explicit v2 adapters and auth selectors (omitting the mode preserves v1):
NODE_RED_AGENTS_OPENCODE_MODE=v2 make test-model-e2e
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
`NODE_RED_AGENTS_OPENCODE_MODE=v1|v2` selects both the explicit agent auth selector
and agent-server API adapter; the default remains v1. It exercises the selected
adapter and daemon credential rotation;
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

Original issues **#66, #68 and #71 remain partially accepted** pending the
provider/CLI/editor checklist in
[#82](https://github.com/tbrandenburg/node-red-agents/issues/82).
Passing implementation gates does not complete those manual definitions of done.
Outstanding: authenticated Gateway generation/Jev, Pi shared auth,
Copilot OAuth regression, and browser-editor round-trip. OpenCode v2 shared auth
is now covered by the explicit v2 live run below.

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

## OpenCode v2 integration acceptance

Install **v2.0.28**, Node 22+, Linux `ss`/`ps`, and SRT, and provision
`OPENROUTER_API_KEY` in the environment (never on argv). The focused suites use
`openrouter/openai/gpt-4.1-mini`; `E2E_OPENCODE_CANCEL_MODEL` overrides that model.
They reuse the live Node-RED launcher and active-tool fixture, without mocks:

```sh
make test-v2-acceptance
# Equivalent focused command; give the outer runner at least 360000 ms:
NODE_RED_AGENTS_OPENCODE_MODE=v2 E2E_OPENCODE_V2_ACCEPTANCE=1 E2E_OPENCODE_CANCEL=1 node --test --test-concurrency=1 --test-timeout=300000 test/integration/opencode-v2-acceptance.spec.js test/integration/opencode-cancellation.spec.js
```

The Node-RED suite checks:

- An `agent` reads a random sentinel from a cwd different from the runtime's cwd;
  the runtime directory contains a deliberately incorrect sentinel.
- An `agent-server` runs two separate native shell calls and emits one final
  output only after a real persisted `idle` record reports `succeeded`.
- A real child session selects a configured subagent with shell permission denied;
  the live permission API returns `deny`, not a pending approval. This checks policy
  evaluation without asking a model to delegate, and is not live model-delegation coverage.
- The public shell API inserts 55 real records using `printf`, with no 55-model-call
  billing loop. The real first page has 50 messages and a cursor; Node-RED's history
  operation returns the inserted IDs and the older accepted turn without duplicates.
- Server abort and request timeout occur while a real shell tool and descendant
  are active. Neither interrupted prompt emits a success, each emits one failure,
  the captured tools stop without a late write, and the same session responds again.

The CLI suite checks Direct terminate/timeout and SRT terminate against the same
active script. Direct exits through v2's SIGINT handler with code 130; SRT can exit
zero after interruption, but the agent result must still be failed, never completed.
Provider turn durations vary; inability to reach the active tool is a failed probe,
not a passing cancellation result. No automatic provider retry is added by the tests.

The launcher creates HOME/XDG/DB directories outside the repo and uses an allowlisted
environment, not an ambient environment spread. Shared auth comes from native
Node-RED credentials; cancellation uses the actual `resolveCLIAuth` sanitizer with
only the provisioned OpenRouter key. Inherited `OPENCODE_*` service/config settings
are excluded. `ss` runs before launch; Node-RED binds loopback port zero and the
production daemon launcher selects a free loopback port before spawning. Captured
Node-RED/daemon/tool descendant PIDs are verified stopped before profile removal.
No existing shared service is stopped or reconfigured.

Test-only admin probes inspect the owned registry and forward a small allowlist
of real API operations to that daemon. Its Basic credentials stay inside the
disposable Node-RED process; no credential or environment dictionary is returned.

Verified **2026-10-14**, Node **v24.15.0**, OpenCode **v2.0.28**:

| Command | Result |
|---|---|
| `npm test` | 526 passed, 0 failed, 0 skipped |
| `NODE_RED_AGENTS_OPENCODE_MODE=v2 E2E_OPENCODE_MODEL=openrouter/openai/gpt-4.1-nano make test-e2e` | 5 passed, 0 failed, 1 redundant v1-only single-turn skip |
| `NODE_RED_AGENTS_OPENCODE_MODE=v2 make test-model-e2e` | 13 passed, 0 failed, 1 Gateway skip (key absent) |
| Focused v2 Node-RED acceptance command above, server spec only | 6 passed, 0 failed, 0 skipped |
| Focused cancellation command above, CLI spec only | 4 passed, 0 failed, 0 skipped |

Final supported-target verification on **2026-10-15**:
`make test-v2-acceptance` reported **10 passed, 0 failed, 0 skipped** in 110.60 s;
`make format`, `make lint` and `git diff --check` passed. The repeated v2 model
suite reported **13 passed, 0 failed, 1 Gateway skip**. Each live launcher checked
its captured process tree at teardown; the pre-existing shared service remained running.

The exact CI-default command, `NODE_RED_AGENTS_OPENCODE_MODE=v2 make test-e2e`,
then reported **4 passed, 1 failed, 1 intentional skip**. The MCP turn received
provider HTTP **403**: “OpenCode's free tier can only be used from within OpenCode.”
This reproduces the provider response tracked in
[#78](https://github.com/tbrandenburg/node-red-agents/issues/78); the test was not
skipped, weakened or switched to a billed CI model. Later comparisons and unchanged
reruns below establish that the failure is intermittent, not a persistent rejection.

The v2 CI pin changes from 2.0.18 to **2.0.28** after verifying the published npm
version, installed CLI and authenticated real acceptance; the v1 pin remains
**1.18.32**. Local acceptance does not certify the branch's GitHub jobs; those
must independently exercise the updated implementation and pin.

Harness pitfalls found and corrected during acceptance:

- Native v2 `shell` is a top-level tool with `codemode: false`; it is absent from
  Code Mode's `search` catalog. Asking a model to discover it there caused empty
  search results and false claims of tool unavailability. Use native shell directly.
- Nested `node:test` scenarios must use their own TestContext: awaiting a sibling
  scheduled on the parent while its current child is running deadlocks the suite.
- Shell API admission may return an empty 204 response; observe durable history,
  not JSON parsing of an empty body. Lifecycle debug events correlate by `_msgid`,
  not arbitrary custom message fields.
- SRT needs `CLAUDE_CODE_TMPDIR` inside its writable profile; allowlisting only
  `TMPDIR` caused an `EROFS` failure before the real CLI could execute.
- A model mistyped a random absolute script path, preventing tool admission.
  The active fixture now uses `./active.js` in the verified private cwd and a
  short unique process title for host-PID capture, including SRT's PID namespace.

References: [v2 API and OpenAPI](https://opencode.ai/v2/docs/api/),
[v2 configuration](https://opencode.ai/v2/docs/config/), and
[v2 permissions](https://opencode.ai/v2/docs/permissions/). Native shell discovery
behavior was verified against the installed v2.0.28 binary, not inferred from v1 docs.

### Coordinator integration verification, 2026-10-15

After reviewing the combined implementation, manual cancellation was made
non-retryable and post-exit process cleanup was restricted to identity-verified
owned processes. Coordinator validation against that implementation:

| Command | Result |
|---|---|
| `make format lint test` | Passed; 535 tests passed, 0 failed, 0 skipped |
| `make test-v2-acceptance` | 10 passed, 0 failed, 0 skipped; 109.93 s |
| `NODE_RED_AGENTS_OPENCODE_MODE=v2 make test-model-e2e` | 13 passed, 0 failed; Gateway skipped because its key is absent |
| `NODE_RED_AGENTS_OPENCODE_MODE=v2 E2E_OPENCODE_MODEL=openrouter/openai/gpt-4.1-mini make test-e2e` | 5 passed, 0 failed; 1 intentional v1-only skip |
| `NODE_RED_AGENTS_OPENCODE_MODE=v2 make test-e2e` | 4 passed, 1 failed, 1 intentional skip; MCP request reproduced #78's provider HTTP 403 |

The same authenticated smoke command with `openrouter/openai/gpt-4.1-nano`
failed two behavioral assertions: resume output omitted `second`, and MCP output
claimed tool unavailability. The tests remained unchanged; model-driven smoke
results are not deterministic; tracked in
[#83](https://github.com/tbrandenburg/node-red-agents/issues/83).
The mini-model run is positive behavioral
evidence, not certification of the unmetered CI model or nano-model reliability.
Pre-existing service listeners and their visible PIDs were unchanged after these
coordinator runs. No separate typecheck command is configured.

### Free-model CI/local comparison

The main-branch GitHub run
[38374770126](https://github.com/tbrandenburg/node-red-agents/actions/runs/38374770126)
passed its v1 and v2 E2E jobs. Its v2 job used **2.0.18** and executed the MCP test
successfully; the MCP test was not skipped.

Controlled standalone probes with private HOME/XDG/DB profiles passed plain
prompts and MCP calls on **both 2.0.18 and 2.0.28**. MCP also passed with both old
and corrected permission ordering: six successful version/ordering probes.
Four additional v2.0.28 probes passed with repository cwd, global configuration,
neutral cwd, and inherited environment variants. Global credentials were not
printed or exported; profiles used separate data directories.

Two consecutive unchanged runs of
`NODE_RED_AGENTS_OPENCODE_MODE=v2 make test-e2e` then each reported **5 passed,
0 failed, 1 intentional skip**, using the original `opencode/big-pickle` model.
No production code or CI model was changed during those comparisons.

The precise trigger of the earlier HTTP 403 remains unproven. These results do
not establish a deterministic CLI-upgrade, permission-ordering, or profile
regression, nor do they prove that the provider will never reject a later call.
Keep the free-model CI default and track intermittent failures in #78 rather
than introducing paid CI credentials or weakening behavioral assertions.

The final pre-publication gate on **2026-10-15** repeated `make format lint test`
with **535 passed, 0 failed, 0 skipped**, and the unchanged default v2 E2E command
with **5 passed, 0 failed, 1 intentional skip**. No typecheck script is configured;
no tracked data/demo flows or lockfiles changed during these checks.
