#!/usr/bin/env bash
# Agentic Dev Team helper: ensure the shared bare base clone of
# <host>/<owner>/<repo> exists under workspace/ and is fetched to the tip of
# its default branch. This is the sole source `git worktree add` checks out
# task worktrees from (see ensure-worktree.sh); it is never checked out
# itself. Safe to call concurrently for the same repo (serialized via a
# flock on the base clone directory) and for different repos (independent
# lock files, never contend).
#
# Usage: prime-base.sh <host> <owner> <repo>
# Prints, on success, two lines to stdout:
#   REPO_DIR=<absolute path to the bare base clone>
#   DEFAULT_BRANCH=<default branch name>

set -euo pipefail

HOST="${1:?host required}"
OWNER="${2:?owner required}"
REPO="${3:?repo required}"

# Defense in depth: the flow already validates these before invoking this
# script, but never trust input that ends up in a shell command.
for value in "$HOST" "$OWNER" "$REPO"; do
    if [[ ! "$value" =~ ^[A-Za-z0-9._-]+$ ]]; then
        echo "prime-base: invalid argument '$value'" >&2
        exit 1
    fi
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_DIR="$ROOT_DIR/workspace"
BASE_DIR="$WORKSPACE_DIR/${OWNER}__${REPO}.base"
LOCK_FILE="$WORKSPACE_DIR/.${OWNER}__${REPO}.lock"

mkdir -p "$WORKSPACE_DIR"

# Serialize base-clone creation/fetch across concurrent invocations for the
# same repo; different repos use different lock files and never contend.
# Use a fixed fd (200) rather than bash's `{varname}` auto-assigned fd
# syntax, which requires bash >= 4.1 and isn't supported by the bash 3.2
# that macOS ships as /bin/bash (Apple has not updated it since 2007 due
# to bash 4+'s GPLv3 license).
lock_fd=200
eval "exec $lock_fd>\"$LOCK_FILE\""
flock "$lock_fd"

if ! git -C "$BASE_DIR" rev-parse --is-bare-repository >/dev/null 2>&1; then
    git clone --bare "https://${HOST}/${OWNER}/${REPO}.git" "$BASE_DIR"
    # `clone --bare` copies refs/heads/* directly and does NOT set up a
    # remote-tracking refspec the way a normal clone does, so `origin/<br>`
    # would never exist without this: configure fetch to populate
    # refs/remotes/origin/* instead, leaving refs/heads/* free for
    # ensure-worktree.sh's task branches.
    git -C "$BASE_DIR" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
fi

git -C "$BASE_DIR" fetch origin

DEFAULT_BRANCH="$(git -C "$BASE_DIR" remote show origin | sed -n 's/.*HEAD branch: //p')"
if [ -z "$DEFAULT_BRANCH" ]; then
    echo "prime-base: could not determine default branch" >&2
    exit 1
fi

flock -u "$lock_fd"

echo "REPO_DIR=$BASE_DIR"
echo "DEFAULT_BRANCH=$DEFAULT_BRANCH"
