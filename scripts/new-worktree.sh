#!/usr/bin/env bash
#
# Spawn an isolated git worktree for parallel feature development.
#
# Two `pnpm dev` runs from different worktrees bind different host ports and
# use different Docker Compose project names, so containers, named volumes,
# and SQLite files all stay isolated.
#
# Modes:
#   bash scripts/new-worktree.sh <branch> [base]   # new branch from base (default: main)
#   bash scripts/new-worktree.sh pr <number>       # check out an open PR (requires gh)
#
# Examples:
#   bash scripts/new-worktree.sh feat/foo
#   bash scripts/new-worktree.sh fix/bar develop
#   bash scripts/new-worktree.sh pr 67

set -euo pipefail

# ---------------------------------------------------------------------------
# Prerequisites
#
# The remaining steps either create files on disk or mutate the git index;
# failing partway through risks a half-created worktree. Surface missing
# tools NOW so the script can't crash after `git worktree add`.

check_prereq() {
  local bin="$1"
  local hint="$2"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "error: required binary '$bin' not found in PATH" >&2
    echo "       $hint" >&2
    exit 1
  fi
}

check_prereq git "install git (>=2.5)"
check_prereq pnpm "run 'corepack enable' (or install Node 24+ first)"

# ---------------------------------------------------------------------------
# Argument parsing — two modes:
#
#   branch mode:  <branch> [base]
#   pr mode:      pr <number>

if [[ $# -lt 1 ]]; then
  cat <<'USAGE' >&2
usage:
  bash scripts/new-worktree.sh <branch> [base]   # new branch from base (default: main)
  bash scripts/new-worktree.sh pr <number>       # check out an open PR
USAGE
  exit 2
fi

MODE=""
BRANCH=""
BASE=""
PR_NUMBER=""
SLUG=""

if [[ "$1" == "pr" ]]; then
  MODE="pr"
  if [[ $# -lt 2 ]]; then
    echo "error: 'pr' mode requires a PR number (e.g. 'pr 67')" >&2
    exit 2
  fi
  PR_NUMBER="$2"
  if [[ ! "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "error: PR number must be numeric (got '$PR_NUMBER')" >&2
    exit 2
  fi
  check_prereq gh "install GitHub CLI: https://cli.github.com (required for 'pr' mode)"
  SLUG="pr-${PR_NUMBER}"
else
  MODE="branch"
  BRANCH="$1"
  if [[ -z "$BRANCH" ]]; then
    echo "error: branch name is empty" >&2
    exit 2
  fi
  # Restrict branch names to characters that survive shell escaping AND make a
  # sensible directory name. Anything outside this set is almost certainly a
  # typo (or a quoting bug) rather than a real git branch.
  if [[ ! "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    echo "error: branch name must match [A-Za-z0-9._/-]+" >&2
    exit 2
  fi
  BASE="${2:-main}"
  # `/` → `-` so `feat/foo` becomes one path segment.
  SLUG="${BRANCH//\//-}"
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
# `dirname` rather than literal `..` — `..` traverses symlink targets (homebrew
# installs, macOS /private/var aliasing) while dirname strips the trailing
# component of the literal path.
DIR="$(dirname "$REPO_ROOT")/xray-${SLUG}"

if [[ -e "$DIR" ]]; then
  echo "error: $DIR already exists — refusing to overwrite" >&2
  echo "       to start fresh:" >&2
  echo "         (cd '$DIR' && docker compose -f compose.dev.yaml down -v)" >&2
  echo "         git worktree remove --force '$DIR'" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Port pick
#
# Floor is 8081 — 8080 stays reserved for the main checkout's default
# `pnpm dev`. Probe via bash built-in /dev/tcp so the script doesn't drag in
# an `lsof` / `ss` / `nc` host dependency.
#
# Two back-to-back invocations of this script (before either `pnpm dev` runs)
# would otherwise both pick 8081 — the /dev/tcp probe only sees ports with
# something already listening. Scan sibling worktrees' .env files for already
# claimed HOST_PORT values and skip those too.

port_in_use() {
  local port="$1"
  if (exec 6<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
    exec 6<&- 2>/dev/null || true
    exec 6>&- 2>/dev/null || true
    return 0
  fi
  return 1
}

claimed_ports() {
  shopt -s nullglob
  local env_file
  for env_file in "$(dirname "$REPO_ROOT")"/xray-*/.env; do
    grep -E '^HOST_PORT=[0-9]+' "$env_file" 2>/dev/null | cut -d= -f2 || true
  done
}

CLAIMED=" $(claimed_ports | tr '\n' ' ') "
PORT=8081
while port_in_use "$PORT" || [[ "$CLAIMED" == *" $PORT "* ]]; do
  PORT=$((PORT + 1))
  if [[ $PORT -gt 9000 ]]; then
    echo "error: no free port in 8081..9000" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Rollback trap
#
# Anything below this line might fail and leave a half-created worktree. The
# trap removes the worktree (and any branch this script created) on non-zero
# exit so re-running starts from a clean slate.

CREATED_WORKTREE=0
CREATED_BRANCH=""

cleanup_on_error() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "error: aborted (exit $rc) — rolling back partial worktree" >&2
    if [[ $CREATED_WORKTREE -eq 1 ]]; then
      git worktree remove --force "$DIR" 2>/dev/null || true
    fi
    if [[ -n "$CREATED_BRANCH" ]]; then
      git branch -D "$CREATED_BRANCH" 2>/dev/null || true
    fi
  fi
  exit $rc
}
trap cleanup_on_error EXIT

# ---------------------------------------------------------------------------
# Create the worktree

if [[ "$MODE" == "branch" ]]; then
  git worktree add -b "$BRANCH" "$DIR" "$BASE"
  CREATED_WORKTREE=1
  CREATED_BRANCH="$BRANCH"
else
  # `--detach`: don't create a local branch here. `gh pr checkout` will fetch
  # the PR head, create a local branch from it, and `--force` past any
  # existing checkout. Works for both same-repo PRs and fork PRs.
  git worktree add --detach "$DIR" HEAD
  CREATED_WORKTREE=1
  (cd "$DIR" && gh pr checkout "$PR_NUMBER" --force)
  CREATED_BRANCH="$(cd "$DIR" && git rev-parse --abbrev-ref HEAD)"
fi

# ---------------------------------------------------------------------------
# Seed .env
#
# Prefer copying the main checkout's .env (so existing local secrets carry
# over); fall back to .env.example for a fresh clone. `cp -p` preserves
# chmod 600 if the source was tightened. `.env` is gitignored, and worktrees
# share the .git tree, so the new worktree inherits the same gitignore rule.

if [[ -f "${REPO_ROOT}/.env" ]]; then
  cp -p "${REPO_ROOT}/.env" "${DIR}/.env"
else
  cp -p "${REPO_ROOT}/.env.example" "${DIR}/.env"
fi

{
  echo ""
  echo "# --- auto-added by scripts/new-worktree.sh ---"
  echo "HOST_PORT=${PORT}"
  echo "COMPOSE_PROJECT_NAME=xray-${SLUG}"
} >> "${DIR}/.env"

# ---------------------------------------------------------------------------
# Install deps on the host so the developer's IDE / tsc / biome see a real
# node_modules. The dev container has its own `dev_node_modules` named volume
# so this host install does not collide with what runs inside Docker.

(cd "$DIR" && pnpm install --frozen-lockfile)

# ---------------------------------------------------------------------------
# Summary — also persisted to <dir>/.worktree-info so other tooling (CI, a
# fresh Claude session opened in the new dir) can `cat` it deterministically
# instead of scraping stdout interleaved with `pnpm install` output.

SUMMARY="worktree ready
  path:        ${DIR}
  branch:      ${CREATED_BRANCH}  (mode: ${MODE})
  host port:   ${PORT}
  compose:     xray-${SLUG}

heads up:
  ${DIR}/.env was copied from this checkout — verify before any commit.

next:
  cd \"${DIR}\"
  pnpm dev          # -> http://localhost:${PORT}

teardown:
  cd \"${DIR}\" && docker compose -f compose.dev.yaml down -v
  cd \"${REPO_ROOT}\" && git worktree remove \"${DIR}\" && git branch -D \"${CREATED_BRANCH}\"
"

printf '%s\n' "$SUMMARY"
printf '%s\n' "$SUMMARY" > "${DIR}/.worktree-info"

# Success — disarm the rollback trap.
trap - EXIT
