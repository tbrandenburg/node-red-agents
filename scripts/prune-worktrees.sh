#!/usr/bin/env bash
# Agentic Dev Team helper: remove every task worktree for a repo, leaving the
# shared base clone intact. Run at the beginning of every Start to bound disk
# growth to one schedule cycle.
#
# Usage: prune-worktrees.sh <owner> <repo>

set -euo pipefail

OWNER="${1:?owner required}"
REPO="${2:?repo required}"

for value in "$OWNER" "$REPO"; do
    if [[ ! "$value" =~ ^[A-Za-z0-9._-]+$ ]]; then
        echo "prune-worktrees: invalid argument '$value'" >&2
        exit 1
    fi
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_DIR="$ROOT_DIR/workspace"
BASE_DIR="$WORKSPACE_DIR/${OWNER}__${REPO}.base"

if [ ! -d "$BASE_DIR/.git" ]; then
    echo "prune-worktrees: no base clone at $BASE_DIR, nothing to do" >&2
    exit 0
fi

for dir in "$WORKSPACE_DIR/${OWNER}__${REPO}--"*; do
    [ -e "$dir" ] || continue
    if ! git -C "$BASE_DIR" worktree remove --force "$dir" 2>/dev/null; then
        rm -rf "$dir"
    fi
done

git -C "$BASE_DIR" worktree prune

echo "PRUNED=${OWNER}__${REPO}"
