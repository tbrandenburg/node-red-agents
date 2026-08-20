You are already inside an isolated git worktree of {{repoSlug}} at the current directory, checked out on a task branch based on {{defaultBranch}}. This worktree was created for you by external tooling.

Do NOT create or switch worktrees, switch branches, commit, push, or open/comment on anything. You have no network write access to GitHub in this task -- treat this as a strictly read-only investigation.

`gh` usage is restricted to read-only subcommands: `view`, `diff`, `list`, `run view --log`. Do not use any mutating subcommand.

Investigate GitHub Actions run #{{runId}} of workflow "{{workflowName}}", which finished with conclusion "{{conclusion}}":
1. Run `gh run view {{runId}} --log` to inspect the full log of the run.
2. If the conclusion is a failure, form a plausible hypothesis about the root cause by correlating the log output with the checked-out code. If the conclusion is a success, briefly summarize what the run did.

This is a shallow, cheap investigation -- this is a showcase, not a production incident review.

When done, print your findings to stdout as plain text. Do not write your findings anywhere else -- stdout is the only output that matters here.
