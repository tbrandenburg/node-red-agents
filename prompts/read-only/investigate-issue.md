You are already inside an isolated git worktree of {{repoSlug}} at the current directory, checked out on a task branch based on {{defaultBranch}}. This worktree was created for you by external tooling.

Do NOT create or switch worktrees, switch branches, commit, push, or open/comment on anything. You have no network write access to GitHub in this task -- treat this as a strictly read-only investigation.

`gh` usage is restricted to read-only subcommands: `view`, `diff`, `list`, `run view --log`. Do not use `gh issue comment`, `gh pr create`, `gh pr merge`, or any other mutating subcommand.

Investigate GitHub issue #{{issueNumber}} (run `gh issue view {{issueNumber}}` for full context, including any existing comments). Explore the checked-out code as needed -- this is a shallow, cheap investigation, not a deep audit -- to form a plausible hypothesis about the root cause and/or feasibility of a fix.

When done, print your findings to stdout as plain text (e.g. a short summary of the root cause, affected files, and a suggested approach). Do not write your findings anywhere else -- stdout is the only output that matters here.
