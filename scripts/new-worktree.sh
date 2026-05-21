#!/usr/bin/env bash
#
# Spawn an isolated git worktree for parallel feature development.
#
# Creates a sibling directory `../xray-<slug>` checked out to a new branch,
# seeds its own `.env`, picks a free host port, and runs `pnpm install` so
# `pnpm dev` works immediately. Two `pnpm dev` runs from different worktrees
# bind different host ports and use different Docker Compose project names,
# so containers, named volumes, and SQLite files all stay isolated.
#
# Usage:
#   bash scripts/new-worktree.sh <branch> [base]
#
# Examples:
#   bash scripts/new-worktree.sh feat/foo            # base = main
#   bash scripts/new-worktree.sh fix/bar develop
#
# Idempotency: if the target worktree already exists, the script exits
# non-zero rather than mutating it.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <branch> [base]" >&2
  exit 2
fi

BRANCH="$1"
BASE="${2:-main}"

# slug: replace `/` with `-` so `feat/foo` becomes `feat-foo` and the dir name
# is a single path segment.
SLUG="${BRANCH//\//-}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
DIR="${REPO_ROOT}/../xray-${SLUG}"

if [[ -e "$DIR" ]]; then
  echo "error: $DIR already exists — refusing to overwrite" >&2
  exit 1
fi

# Pick the lowest free TCP port at or above 8081. 8080 stays reserved for the
# main checkout's default `pnpm dev`. `lsof` is available on macOS + Linux and
# avoids the "is port really free" race better than `ss` heuristics.
PORT=8081
while lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
  if [[ $PORT -gt 9000 ]]; then
    echo "error: no free port in 8081..9000" >&2
    exit 1
  fi
done

git worktree add -b "$BRANCH" "$DIR" "$BASE"

# Seed the new worktree's .env. Prefer copying the main checkout's .env so
# the developer's existing secrets carry over; fall back to .env.example for a
# fresh checkout. `.env` is gitignored so the new worktree keeps its own copy
# without ever leaking it into a commit.
if [[ -f "${REPO_ROOT}/.env" ]]; then
  cp "${REPO_ROOT}/.env" "${DIR}/.env"
else
  cp "${REPO_ROOT}/.env.example" "${DIR}/.env"
fi

# Append the worktree-specific overrides. HOST_PORT and COMPOSE_PROJECT_NAME
# are the two knobs `compose.dev.yaml` reads to keep parallel runs isolated.
{
  echo ""
  echo "# --- auto-added by scripts/new-worktree.sh ---"
  echo "HOST_PORT=${PORT}"
  echo "COMPOSE_PROJECT_NAME=xray-${SLUG}"
} >> "${DIR}/.env"

# Install deps inside the new worktree so the host's IDE / tsc / biome see a
# real node_modules. The dev container has its own `dev_node_modules` volume
# so this host install does not collide with what runs inside Docker.
(cd "$DIR" && pnpm install --frozen-lockfile)

cat <<EOF

worktree ready
  path:        ${DIR}
  branch:      ${BRANCH}  (based on ${BASE})
  host port:   ${PORT}
  compose:     xray-${SLUG}

next:
  cd ${DIR}
  pnpm dev          # → http://localhost:${PORT}

teardown:
  cd ${DIR} && docker compose -f compose.dev.yaml down -v
  cd ${REPO_ROOT} && git worktree remove ${DIR}
EOF
