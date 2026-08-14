You are working in a checkout of {{repoSlug}} at the current directory (default branch: {{defaultBranch}}).

Merge pull request #{{prNumber}}, which is intended to fix issue #{{issueNumber}} (run `gh pr view {{prNumber}}` and `gh issue view {{issueNumber}}` for full context).

Steps:
1. Review the diff (`gh pr diff {{prNumber}}`) and confirm it plausibly fixes issue #{{issueNumber}}.
2. Verify CI status is passing (`gh pr checks {{prNumber}}`). If checks are failing or still running, do not merge -- report the status and stop.
3. If the diff looks correct and checks are green, merge the PR:
     gh pr merge {{prNumber}} --squash --delete-branch
4. Post a comment on issue #{{issueNumber}} confirming the merge, e.g.:
     gh issue comment {{issueNumber}} --body "Merged #{{prNumber}}."

If you have any doubt about correctness, or the checks are not green, do not merge -- instead post a comment on the PR explaining what's blocking it.
