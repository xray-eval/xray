# Contributing

Thanks for considering a contribution. This repo is intentionally small and easy to audit — please keep it that way.

## Ground rules

- **pnpm only.** `npm install`, `yarn add`, and `bun install` are blocked by a `preinstall` hook. Use `corepack enable` to pick up the pinned pnpm version.
- **Supply chain is non-negotiable.** Read [`.claude/rules/supply-chain.md`](./.claude/rules/supply-chain.md) before adding any dependency. The 7-day cooldown, deny-by-default lifecycle scripts, and SHA-pinned GitHub Actions are not optional.
- **This repo is public.** Read [`.claude/rules/public-repo.md`](./.claude/rules/public-repo.md) before touching `.env`, the Dockerfile, or commit messages. A leaked secret must be **rotated**, never rewritten.
- **Conventional commits.** Enforced by commitlint in the `commit-msg` hook. Examples: `feat(adapter): add retell adapter`, `fix(server): handle missing api key`.
- **No `as` casts.** Banned by a custom Biome plugin ([`biome-plugins/no-as-cast.grit`](./biome-plugins/no-as-cast.grit)). The **only** allowed form is `as const` (literal-type widening control — not a cast). For everything else: use `satisfies`, a type guard, or `ts-pattern.match`.

## First-time setup

```bash
corepack enable
pnpm install
```

`pnpm install` runs `lefthook install` automatically (via the `prepare` script), wiring up pre-commit (Biome + tsc + gitleaks) and commit-msg (commitlint) hooks.

Install **gitleaks** on your machine — the pre-commit hook calls the binary directly to keep CI = local:

```bash
# macOS
brew install gitleaks
# Arch
sudo pacman -S gitleaks
# Debian/Ubuntu (no apt package) — download the pinned release:
curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
  | tar -xz gitleaks && sudo install -m 0755 gitleaks /usr/local/bin/ && rm gitleaks
```

Why: see [`.claude/rules/public-repo.md`](./.claude/rules/public-repo.md) §4. The pre-commit hook is the *only* layer that prevents a leak rather than mitigating one — Push Protection and CI both run after the commit exists.

### Python SDK (only if you touch `sdk/python/`)

The pre-commit `ruff` step calls `sdk/python/.venv/bin/ruff` directly to match the CI invocation in [`.github/workflows/test-python-sdk.yml`](./.github/workflows/test-python-sdk.yml). Bootstrap the venv once:

```bash
cd sdk/python
uv venv
uv pip install -e '.[dev]'
```

`uv` itself is pinned via `.tool-versions` (install: `curl -LsSf https://astral.sh/uv/install.sh | sh` or `brew install uv`).

## Daily loop

```bash
pnpm dev              # Single Bun container serving SPA + API on :8080 with HMR
pnpm typecheck        # tsc --noEmit
pnpm check            # biome check (lint + format)
pnpm check:fix        # biome check --write
pnpm test             # bun test
pnpm test:watch       # bun test --watch (the TDD loop)
pnpm test:coverage    # bun test --coverage — same gate CI runs
pnpm docker:smoke     # build the production image, run it, curl /healthz, kill it
```

### TDD

Every behavior lands red → green → refactor. The failing test goes in *first*, runs (and fails for the right reason), then the production code makes it green. See [`.claude/rules/tdd.md`](./.claude/rules/tdd.md). The CI `test` workflow runs `pnpm test:coverage` and fails the build if coverage drops below the thresholds in `bunfig.toml`.

`pnpm docker:smoke` is the **single most important** local check — it is exactly what CI runs before publishing. If it passes locally, it passes in CI.

## Parallel worktrees

Working on two branches at once — or reviewing a PR without losing your
current train of thought? Use a git worktree so each checkout gets its own
`pnpm dev` container, host port, SQLite file, and `node_modules`:

```bash
bash scripts/new-worktree.sh feat/foo            # new branch from main
bash scripts/new-worktree.sh fix/bar develop     # new branch from develop
bash scripts/new-worktree.sh pr 67               # check out open PR #67 (requires gh)
```

The script creates `../xray-<slug>` (sibling of this repo), copies your
`.env` so existing local secrets carry over (verify before committing — see
[`.claude/rules/public-repo.md`](./.claude/rules/public-repo.md)), picks the
lowest free port at or above 8081, appends `HOST_PORT` + `COMPOSE_PROJECT_NAME`
to the new `.env`, and runs `pnpm install --frozen-lockfile`. The same
summary is also written to `<dir>/.worktree-info` for deterministic lookup
later.

`compose.dev.yaml` reads `HOST_PORT` and `COMPOSE_PROJECT_NAME`, so each
worktree's `pnpm dev` binds a distinct host port and gets its own named
Docker volumes (`xray-<slug>_dev_data`, `xray-<slug>_dev_node_modules`). The
main checkout keeps its `xray-dev` container and `:8080` port because
`.env.example` pins `COMPOSE_PROJECT_NAME=xray` and leaves `HOST_PORT`
commented out.

If the script aborts partway through (e.g. `pnpm install` fails on a stale
lockfile), it rolls back the partial worktree + branch so re-running starts
from a clean slate. The required host tooling is `git`, `pnpm`, and (for
`pr` mode) `gh`; the script checks each before touching anything on disk.

Teardown (the script prints these too):

```bash
cd ../xray-feat-foo
docker compose -f compose.dev.yaml down -v     # wipes the worktree's volumes
cd -
git worktree remove ../xray-feat-foo
git branch -D feat/foo                          # name shown in .worktree-info
```

## Code layout

- **Vertical slices, not technical layers.** `src/adapters/elevenlabs/`, `src/graph/`, `src/inspector/` — each folder owns its own components, hooks, types, helpers. No top-level `components/`, `hooks/`, `services/`, `utils/` god-folders.
- **Tests next to the source.** `foo.ts` and `foo.test.ts` live in the same folder. No `tests/` mirror tree, no `__tests__/`. See [`.claude/rules/code-layout.md`](./.claude/rules/code-layout.md) for the full rationale.

## Adding a provider adapter

The core app is provider-agnostic. Adding a new provider is one file plus tests; no UI changes.

1. Read [`src/adapters/types.ts`](./src/adapters/types.ts) — the `VoiceAgentAdapter` interface and the provider-agnostic types (`Agent`, `Workflow`, `Conversation`, `Turn`).
2. Create the slice: `src/adapters/<provider>/adapter.ts` implementing `VoiceAgentAdapter`, plus any `<provider>`-specific helpers / types in the same folder. Tests live next to the file they test (`adapter.test.ts`).
3. Register it in `src/adapters/registry.ts`.
4. Add a row to the supported-providers table in the README.

The interface is deliberately small — if your provider needs something the interface can't express, open an issue first. Interface churn affects every adapter.

## Adding a dependency

Follow the 5-step gate in [`.claude/rules/supply-chain.md`](./.claude/rules/supply-chain.md) §3 (need · maintainer plausibility · provenance · install scripts · run). If the package has a `postinstall` script, it needs an `allowBuilds` entry in `pnpm-workspace.yaml` with a date + reason — never add one "to make install work."

## Pull requests

- Branch protection requires the `Supply-chain audit` check to pass before merge.
- Do not put secrets, internal hostnames, customer names, or exploit details in PR titles, PR descriptions, commit messages, or issue bodies. GitHub keeps PR metadata even after force-push, and the public Events API surfaces it within seconds. See [`.claude/rules/public-repo.md`](./.claude/rules/public-repo.md) §3.
- One topic per PR. Refactor and feature in the same PR makes review painful.

## Reporting a security issue

Please **do not** open a public issue for a vulnerability. Email `bong.basile@gmail.com` with details and we'll coordinate a fix and disclosure timeline.

## License of contributions

By contributing, you agree that your contributions are licensed under the [Elastic License 2.0](./LICENSE) — the same license as the rest of the project. No CLA is required; the act of opening a PR is the agreement.
