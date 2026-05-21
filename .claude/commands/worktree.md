---
description: Spawn an isolated git worktree for a new feature branch or PR checkout
---

Run `bash scripts/new-worktree.sh $ARGUMENTS` from the repo root.

Two forms:

- `/worktree <branch> [base]` — new branch from `base` (default: `main`).
- `/worktree pr <number>` — check out an open PR via `gh pr checkout`.

After the script finishes, report the path and host port it printed. The
script also writes `<dir>/.worktree-info` with the same details, so a fresh
Claude session opened in the new dir can `cat` it deterministically rather
than scraping `pnpm install` output. Do **not** `cd` into the new worktree
from this session — the developer opens a new editor / Claude pane scoped to
that directory.

If `$ARGUMENTS` is empty, ask the developer whether they want a new branch
(and the branch name + optional base) or to check out a PR (and the PR
number) before running the script.
