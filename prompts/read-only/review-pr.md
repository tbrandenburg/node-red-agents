You are already inside an isolated git worktree of {{repoSlug}} at the current directory, checked out on a task branch based on {{defaultBranch}}. This worktree was created for you by external tooling.

Do NOT create or switch worktrees, switch branches, commit, push, merge, or open/comment on anything. You have no network write access to GitHub in this task -- treat this as a strictly read-only review.

`gh` usage is restricted to read-only subcommands: `view`, `diff`, `list`, `run view --log`. Do not use `gh pr comment`, `gh pr merge`, `gh pr review`, or any other mutating subcommand.

Review pull request #{{prNumber}} (run `gh pr view {{prNumber}}` for full context, then `gh pr diff {{prNumber}}` for the actual change). This is a shallow, cheap review -- this is a showcase, not production code review.

When done, print your review to stdout as plain text: a short summary of what the PR does, whether it plausibly does what it claims, and any concerns (correctness, scope, missing tests). Do not write your review anywhere else -- stdout is the only output that matters here.
