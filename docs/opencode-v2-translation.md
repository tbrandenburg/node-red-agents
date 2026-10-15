# OpenCode v2 translation contracts

The S5 translation checks target the installed OpenCode **v2.0.28**. They do not
change session admission, terminal settlement, recovery, or cancellation.

## Models and permissions

- CLI selectors use `provider/model#variant`. Model IDs can contain additional
  slashes, but neither the provider nor model ID can contain `#`.
- Explicit Effort replaces an embedded variant. Empty or repeated `#` suffixes
  fail validation instead of reaching the CLI.
- The v2 session-model endpoint takes
  `{ "model": { "providerID": "openai", "id": "gpt-5.2", "variant": "high" } }`.
  The variant is not part of `id`.
- Shared-provider authentication authorizes the base model, retaining the variant
  for OpenCode v2/auto selectors. Explicit v1 and Pi keep their literal model IDs.
- Permission rules use last-match precedence. Translation emits allows first,
  denies last, and maps `bash` to `shell`, `task` to `subagent`, and both `write`
  and `patch` to `edit`. This is not a strict allowlist: unspecified tools retain
  the upstream/default policy. Explicit v1 retains its existing tools-map behavior.

Sources: [v2 models](https://opencode.ai/v2/docs/models),
[v2 permissions](https://opencode.ai/v2/docs/permissions), and
[v2 API](https://opencode.ai/v2/docs/api). Context7's `/anomalyco/opencode`
reference supplied the corresponding `Model.Ref` and token-usage schemas;
version-specific source and the private server's `/openapi.json` resolved the
legacy/v2 differences.

## Errors and usage

V2 CLI errors contain `error.type`, `error.message`, and optional `error.status`.
Translation retains those fields for diagnostics and retry classification, while
discarding provider response bodies and transport metadata. The existing
authentication/lifecycle sanitizer redacts credential echoes in messages and
events. Typed auth, quota, permission, aborted, unsupported, invalid-request,
content-policy and unavailable-model failures are not retried, even when their
messages mention a transient failure. V1 `error.name`/`error.data` parsing stays
on its legacy path.

V2 token components are disjoint: `input` is uncached input, `output` is visible
output, `reasoning` is separate, and cache read/write counts are separate input.
Without a reported total, sum these five components. Legacy OpenCode output
includes reasoning; do not add reasoning again when deriving its total.
An explicit finite, nonnegative reported total takes precedence. Missing usage
remains absent rather than being reported as zero.

Pinned source:

- [CLI events](https://github.com/anomalyco/opencode/blob/v2.0.28/packages/cli/src/run/noninteractive.ts)
- [Structured errors](https://github.com/anomalyco/opencode/blob/v2.0.28/packages/schema/src/session-error.ts)
- [Error types](https://github.com/anomalyco/opencode/blob/v2.0.28/packages/core/src/session/to-session-error.ts)
- [Usage normalization](https://github.com/anomalyco/opencode/blob/v2.0.28/packages/core/src/session/usage.ts)
- [Token total](https://github.com/anomalyco/opencode/blob/v2.0.28/packages/schema/src/token-usage.ts)

## Verification

Focused tests live in `opencode-translation.spec.js`, the existing adapter tests,
`cli-provider-auth.spec.js`, and the agent-server model/API tests. They cover
overlapping aliases/wildcards, malformed selectors, effort overrides, fatal versus
transient errors, synthetic credential redaction, and version-specific totals.

An unbilled private-profile probe inspected v2.0.28's live schemas, round-tripped
a model/variant selection, and obtained `effect: "deny"` for `subagent`, `edit`,
and `shell` using the actual adapter-generated rules. A standalone CLI request
with an unavailable synthetic provider emitted `provider.no-route`; the adapter
returned failure with `retryable: false`. No provider generation was requested.
The probe prechecked a free loopback port and stopped its captured server PID.

Custom-agent catalog initialization can briefly return 404. Private probe
readiness used a bounded catalog check after a private location reload; it did
not restart or reconfigure the shared service.
