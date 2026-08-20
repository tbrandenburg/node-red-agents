#!/usr/bin/env bash
# Agentic Dev Team helper: ensure an isolated git worktree for a single task
# exists under workspace/, based on a shared base clone of
# <host>/<owner>/<repo>, checked out on a task branch at the tip of the
# default branch. Safe to call concurrently for *different* taskKeys of the
# same repo; the shared base clone (clone+fetch) is serialized via a flock
# on the base clone directory.
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
LOCK_FILE="$WORKSPACE_DIR/.${OWNER}__${REPO}.lock"
BRANCH="adt/${TASK_KEY}"

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

if [ ! -d "$BASE_DIR/.git" ]; then
    git clone "https://${HOST}/${OWNER}/${REPO}.git" "$BASE_DIR"
fi

git -C "$BASE_DIR" fetch origin

DEFAULT_BRANCH="$(git -C "$BASE_DIR" remote show origin | sed -n 's/.*HEAD branch: //p')"
if [ -z "$DEFAULT_BRANCH" ]; then
    echo "ensure-worktree: could not determine default branch" >&2
    exit 1
fi

# Release the base-clone lock: worktree creation itself is safe to run
# concurrently (git supports multiple worktrees off one base clone), and
# holding the lock any longer would serialize all task setups needlessly.
flock -u "$lock_fd"

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
