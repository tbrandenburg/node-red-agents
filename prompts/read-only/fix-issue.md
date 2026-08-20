You are already inside an isolated git worktree of {{repoSlug}} at the current directory, checked out on a task branch based on {{defaultBranch}}. This worktree was created for you by external tooling, and is not the same worktree (if any) used for a prior investigation of this issue -- do not assume any earlier context survived; re-establish it yourself.

Do NOT create or switch worktrees, switch branches, commit, or push. Do NOT open a pull request or comment on anything. You have no network write access to GitHub in this task -- edit files locally only.

`gh` usage is restricted to read-only subcommands: `view`, `diff`, `list`, `run view --log`. Do not use `gh issue comment`, `gh pr create`, `gh pr merge`, or any other mutating subcommand.

Fix GitHub issue #{{issueNumber}}:
1. Run `gh issue view {{issueNumber}}` to re-establish full context, including any existing comments.
2. Explore the checked-out code as needed -- this is a shallow, cheap fix, not a deep audit.
3. Implement a fix by editing files in this worktree, locally only. Do not commit.

When done, run `git diff` and print a summary of the resulting diff to stdout: what changed, in which files, and why. Do not write this summary anywhere else -- stdout is the only output that matters here.
