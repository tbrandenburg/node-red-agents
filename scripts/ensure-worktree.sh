#!/usr/bin/env bash
# Agentic Dev Team helper: ensure an isolated git worktree for a single task
# exists under workspace/, based on a shared bare base clone of
# <host>/<owner>/<repo> (see prime-base.sh), checked out on a task branch at
# the tip of the default branch. Safe to call concurrently for *different*
# taskKeys of the same repo; the shared base clone (clone+fetch) is
# serialized via prime-base.sh's flock on the base clone directory.
#
# Usage: ensure-worktree.sh <host> <owner> <repo> <taskKey>
# Prints, on success, two lines to stdout:
#   REPO_DIR=<absolute path to the worktree>
#   DEFAULT_BRANCH=<default branch name>

set -euo pipefail

HOST="${1:?host required}"
OWNER="${2:?owner required}"
REPO="${3:?repo required}"
TASK_KEY="${4:?taskKey required}"

# Defense in depth: the flow already validates these before invoking this
# script, but never trust input that ends up in a shell command.
for value in "$HOST" "$OWNER" "$REPO" "$TASK_KEY"; do
    if [[ ! "$value" =~ ^[A-Za-z0-9._-]+$ ]]; then
        echo "ensure-worktree: invalid argument '$value'" >&2
        exit 1
    fi
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_DIR="$ROOT_DIR/workspace"
BASE_DIR="$WORKSPACE_DIR/${OWNER}__${REPO}.base"
WORKTREE_DIR="$WORKSPACE_DIR/${OWNER}__${REPO}--${TASK_KEY}"
BRANCH="adt/${TASK_KEY}"

mkdir -p "$WORKSPACE_DIR"

# Ensure the shared bare base clone exists and is fetched to the tip of its
# default branch; this call is self-serializing across concurrent repos and
# concurrent callers of the same repo (see prime-base.sh), so worktree
# creation below never has to hold that lock itself (git supports multiple
# worktrees off one base clone concurrently).
PRIME_OUTPUT="$("$ROOT_DIR/scripts/prime-base.sh" "$HOST" "$OWNER" "$REPO")"
DEFAULT_BRANCH="$(echo "$PRIME_OUTPUT" | sed -n 's/^DEFAULT_BRANCH=//p')"
if [ -z "$DEFAULT_BRANCH" ]; then
    echo "ensure-worktree: could not determine default branch" >&2
    exit 1
fi

if git -C "$BASE_DIR" worktree list --porcelain | grep -qF "worktree $WORKTREE_DIR"; then
    # Existing, valid worktree: idempotent reset instead of recreation.
    git -C "$WORKTREE_DIR" fetch origin
    git -C "$WORKTREE_DIR" checkout "$BRANCH"
    git -C "$WORKTREE_DIR" reset --hard "origin/${DEFAULT_BRANCH}"
    git -C "$WORKTREE_DIR" clean -fd
elif [ -e "$WORKTREE_DIR" ]; then
    echo "ensure-worktree: $WORKTREE_DIR exists but is not a registered worktree" >&2
    exit 1
else
    if git -C "$BASE_DIR" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
        git -C "$BASE_DIR" worktree add -f "$WORKTREE_DIR" "$BRANCH"
        git -C "$WORKTREE_DIR" reset --hard "origin/${DEFAULT_BRANCH}"
        git -C "$WORKTREE_DIR" clean -fd
    else
        git -C "$BASE_DIR" worktree add -f -b "$BRANCH" "$WORKTREE_DIR" "origin/${DEFAULT_BRANCH}"
    fi
fi

echo "REPO_DIR=$WORKTREE_DIR"
echo "DEFAULT_BRANCH=$DEFAULT_BRANCH"
