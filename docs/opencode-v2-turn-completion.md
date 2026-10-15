# OpenCode v2 server turn completion

`agent-server` supplies a stable caller-generated `msg_`-prefixed `id` to
`POST /api/session/{sessionID}/prompt` and correlates it with the projected transcript from
`GET /api/session/{sessionID}/message`. This behavior is specific to v2; the v1
synchronous message path is unchanged.

## Terminal contract

The v2.0.28 transcript is newest first. In chronological order, the admitted
user message anchors the turn and the first subsequent `type: "idle"` message
bounds its execution. Older idle markers and messages after that terminal
boundary do not belong to the turn. An assistant's `time.completed` marks a
step, including tool-call steps; it does not establish execution completion.

- `succeeded`: return the last completed assistant message inside the turn.
  Its text parts become the result payload; an empty answer is permitted.
- `failed`: reject, using a fixed, sanitized error label when a structured
  terminal error is present. Do not return partial assistant text.
- `interrupted`: reject as `MessageAbortedError: message aborted`, even if a
  preceding assistant step completed.

Missing user anchors or terminal markers keep polling within the existing
request deadline. Invalid terminal outcomes and successful turns without a
completed assistant reject rather than manufacture success. Once a terminal
failure or interruption is observed, later transcript updates cannot turn
that operation into success.

The node retains its existing `completed`/`failed` lifecycle events. Completion
polling follows opaque `cursor.next` values until the admitted anchor is visible,
including turns longer than the default 50-message page. History fetches traverse
the complete newest-first transcript. Each traversal shares one deadline across
pages and response bodies; repeated or malformed cursors fail explicitly. An empty
page terminates traversal even if the preceding page supplied a non-null cursor
(verified against v2.0.28).

## Uncertain submission and timeout recovery

The request deadline covers agent/model selection, admission, completion polling,
and response-body consumption, not only response headers. A failed admission
request may have committed remotely. Its caller-generated ID remains the recovery
anchor even when no admission response arrives; the node does not retry submission
or accept a mismatched response ID.

After a submitted turn fails, the node retains its local busy reservation while
interrupting execution and confirming a durable idle marker for that same anchor.
Recovery has a separate shared budget of the smaller of the request timeout and
five seconds. Confirmed success, failure, or interruption permits reuse, but never
converts the original failed request into a result or `completed` event. An interrupt
acknowledgement without a correlated idle is insufficient.

If interrupt fails or idle cannot be verified, the node removes and stops its owned
private daemon. Reusing the removed session ID is rejected; omitting the ID starts
a replacement daemon. Process shutdown uses the existing bounded SIGTERM/SIGKILL
cleanup. Network and HTTP diagnostics for v2 discard arbitrary remote error bodies.
Cleanup succeeds only after a confirmed child exit; exceeding its confirmation
deadline reports failure rather than claiming termination succeeded.

## Lifecycle and compatibility safeguards

Concurrent inputs reserve startup slots before asynchronous port allocation, so
starting daemons count against `maxInstances`. Spawn errors fail the input without
an unhandled child-process error. Unexpected idle-daemon exits retire the session
and emit a fixed safe failure; in-flight requests report their own failure once.

Automatic CLI version probes have a three-second timeout and bounded output.
Only successful detection is cached; a failed probe warns and temporarily falls
back to v1, allowing later requests to detect v2. Explicit version selection
continues to bypass detection.

V2 private daemons receive canonical `OPENCODE_PASSWORD` matching the client's
Basic Auth password, overriding any inherited canonical password. The v1-compatible
server-password alias is also supplied, but v2.0.28 prioritizes the canonical key.

Unlike v1, v2.0.28 `run --session` explicitly creates unknown session IDs. The
`agent` adapter therefore checks existence using `opencode api --standalone GET
/api/session/{sessionID}` before resuming. A failed check produces a fixed error
and never submits the prompt. The positional-argument-only shell guard then
`exec`s the run CLI, retaining the runtime's owned process group, SIGINT policy,
cwd/PWD, environment and timeout. This guard requires a POSIX `sh`; it never uses
the shared background service. Checking and running use successive private servers;
external deletion between those operations is not an atomic compare-and-resume.

Manual CLI cancellation is non-retryable, including when `retryOnError` is `all`;
timeouts retain their retry policy. Cancellation snapshots owned descendants before
interrupting. After the leader exits, group escalation requires an identity-verified
surviving member of that original group; other verified descendants are signalled
individually, never by an unverified detached group ID. Linux identity uses
`/proc/<pid>/stat` start ticks; other POSIX systems use second-resolution `ps lstart`,
which cannot distinguish same-second PID reuse. Snapshot-to-signal races remain
possible without kernel process handles, and descendants spawned or reparented
before the ownership snapshot may escape discovery. Inspection failures are reported
in execution diagnostics rather than permitting unverified post-exit group signals.

## Contract evidence and validation

Sources: [official v2 API](https://opencode.ai/v2/docs/api) and
[OpenAPI](https://opencode.ai/v2/openapi.json), particularly
`Session.Message.Idle` and prompt admission. The installed `@opencode/cli`
v2.0.28 binary's embedded projection source also maps
`session.execution.succeeded`, `.failed`, and `.interrupted` to durable idle
messages; shutdown interruption deliberately omits that marker.

The v2.0.28 embedded `Session.Message.ID` schema checks the `msg_` prefix;
`Session.prompt` uses the supplied `id` before reconciliation/admission and wakes
execution after admission. Official OpenAPI exposes optional prompt `id` with
pattern `^msg_`, corroborated by Context7's v2 API documentation. No UUID syntax
restriction is imposed by this contract; the node uses a UUID suffix for uniqueness.

Focused regression coverage includes multi-step generation, streaming final
answers, reused sessions with stale idle, later turns, terminal provider errors,
interruption with partial text, malformed terminals, and empty final answers:

```sh
node --test packages/node-red-agents/nodes/agent-server/test/*.spec.js packages/node-red-agents/nodes/agent-server/test/integration/*.spec.js
```

A disposable real v2.0.28 server with private HOME/XDG directories and an
intentionally unavailable model verified user admission followed by a failed
idle marker and rejection without a fabricated assistant answer. This checks
the real server's failure contract; model-backed successful and actively
interrupted turn acceptance still requires separate live-provider validation.
