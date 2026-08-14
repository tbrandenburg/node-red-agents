You are working in a checkout of {{repoSlug}} at the current directory (default branch: {{defaultBranch}}).

Fix GitHub issue #{{issueNumber}} (run `gh issue view {{issueNumber}}` for full context, including any existing comments).

Steps:
1. Create a git worktree for this task, e.g.:
     git worktree add ../{{repo}}-issue-{{issueNumber}} -b fix/issue-{{issueNumber}}
   Add its path to .git/info/exclude (not the repo's tracked .gitignore) so it stays local-only.
2. In that worktree, implement a fix for the issue.
3. Commit your changes with a clear message, then push the branch:
     git push -u origin fix/issue-{{issueNumber}}
4. Open a pull request against {{defaultBranch}}, with a body that includes "Closes #{{issueNumber}}":
     gh pr create --base {{defaultBranch}} --title "<title>" --body "Closes #{{issueNumber}}

<description>"
