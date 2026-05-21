---
description: Spawn an isolated git worktree for a new feature branch
---

Run `bash scripts/new-worktree.sh $ARGUMENTS` from the repo root.

After the script finishes, report the path and host port it printed. Do **not**
`cd` into the new worktree from this session — the developer opens a new
editor / Claude pane scoped to that directory.

If `$ARGUMENTS` is empty, ask the developer for the branch name (and optional
base, defaulting to `main`) before running the script.
