#!/usr/bin/env bash
# Agent Repo Workflow helper: ensure a local clone of <host>/<owner>/<repo>
# exists under workspace/ and is fast-forwarded to the tip of its default
# branch. Safe to call repeatedly/concurrently for *different* repos; callers
# are responsible for serializing concurrent calls for the *same* repo (see
# the arw-repo-gate function node in the subflow).
#
# Usage: ensure-repo.sh <host> <owner> <repo>
# Prints, on success, two lines to stdout:
#   REPO_DIR=<absolute path to the clone>
#   DEFAULT_BRANCH=<default branch name>

set -euo pipefail

HOST="${1:?host required}"
OWNER="${2:?owner required}"
REPO="${3:?repo required}"

# Defense in depth: the flow already validates these before invoking this
# script, but never trust input that ends up in a shell command.
for value in "$HOST" "$OWNER" "$REPO"; do
    if [[ ! "$value" =~ ^[A-Za-z0-9._-]+$ ]]; then
        echo "ensure-repo: invalid argument '$value'" >&2
        exit 1
    fi
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_DIR="$ROOT_DIR/workspace"
DIR="$WORKSPACE_DIR/${OWNER}__${REPO}"

mkdir -p "$WORKSPACE_DIR"

if [ ! -d "$DIR/.git" ]; then
    git clone "https://${HOST}/${OWNER}/${REPO}.git" "$DIR"
fi

git -C "$DIR" fetch origin

DEFAULT_BRANCH="$(git -C "$DIR" remote show origin | sed -n 's/.*HEAD branch: //p')"
if [ -z "$DEFAULT_BRANCH" ]; then
    echo "ensure-repo: could not determine default branch" >&2
    exit 1
fi

git -C "$DIR" checkout "$DEFAULT_BRANCH"
git -C "$DIR" reset --hard "origin/${DEFAULT_BRANCH}"
git -C "$DIR" clean -fd

echo "REPO_DIR=$DIR"
echo "DEFAULT_BRANCH=$DEFAULT_BRANCH"
