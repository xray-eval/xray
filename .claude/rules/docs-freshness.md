# Docs track the code — audit them when the surface moves

The prose docs in this repo (`docs/`, the root `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `sdk/python/README.md`) are **untrusted by default**: a comment, a docstring, or a markdown table is a claim about the code, not the code itself, and it drifts silently the moment the thing it describes changes. There is **no CI gate** for this on purpose — AI-in-CI is too expensive for a self-hosted single-image project, and a deterministic denylist of stale strings rots faster than the docs it guards. So freshness is a *process* obligation, enforced by this rule plus the [`/audit-docs`](../commands/audit-docs.md) command, not by a check.

The failure mode this prevents: someone renames `LiveKitDriver` → `LiveKitRuntime` in the SDK, the rename compiles and the tests pass, but six markdown files still say `LiveKitDriver` — and a reader who copies the example gets an `ImportError`. That was a real, whole-PR cleanup (the docs rewrite that introduced this rule). The fix is cheap *at the point of change* (you're already in the code) and expensive later (a full re-audit).

---

## 1 · The obligation

When you change a **public surface** — anything a doc describes — re-check the docs it maps to **in the same change**, the same "fix in passing" reflex as [`pattern-matching.md`](./pattern-matching.md) §4 and [`comments.md`](./comments.md) §4. You do not need to rewrite a doc you didn't invalidate; you need to confirm the ones you *did* touch still tell the truth.

Before opening a PR that touches any row's left column below, run [`/audit-docs`](../commands/audit-docs.md) (or do the equivalent by hand). It's advisory, not gated — but the audit is cheap and the drift is embarrassing in a public repo.

## 2 · The source → doc map

Coarse on purpose (directory / file → doc), so it survives refactors that a line-level map wouldn't. If you add a doc or a new public surface, add the edge here.

| If you change…                                              | Re-check…                                                                 |
|-------------------------------------------------------------|---------------------------------------------------------------------------|
| `sdk/python/src/xray/__init__.py` (`__all__`), `conversation.py`, `config.py`, `errors.py`, `instrument.py`, `orchestrator.py` (public signatures) | `docs/sdk-python.md` (API table + signatures), `sdk/python/README.md` (quickstart) |
| `sdk/python/src/xray/runtime/*` (runtime classes / ABC / protocols) | `docs/sdk-python.md` (Runtimes), `docs/integrate.md` (example imports)     |
| `src/server/store/schema.ts` (tables, `lifecycle_state` / `analysis_step` / `failure_reason` enums) | `docs/architecture.md` (storage ERD + table list), `docs/integrate.md`, `CLAUDE.md` (Storage ¶) |
| `src/server/otlp/vocabularies/*`                            | `docs/wire-contract.md` (vocabularies), `docs/integrate.md` (vocab section) |
| `src/server/otlp/otlp.types.ts` (size / span caps, error shapes) | `docs/wire-contract.md` (Limits + status codes)                           |
| `src/server/env/env.ts` (`XRAY_*` env vars + defaults)      | `docs/sdk-python.md`, `docs/architecture.md`, `README.md`, `CONTRIBUTING.md` |
| Control-plane routes (`src/server/**/<slice>.router.ts`)    | `docs/architecture.md` (control-plane list). The OpenAPI at `/docs` self-syncs from `describeRoute` — only the *narrative* needs a human. |

> **The public docs site.** `docs/*.md` are the source for the site at https://xray-eval.github.io/xray/ — built by VitePress (`docs/.vitepress/config.mts`, `base: '/xray/'`) and deployed by `.github/workflows/docs.yml` on a release tag. They render on GitHub too, so keep them **plain markdown** (no MDX / Vue components) and keep in-docs links relative (`./other-page.md`).

## 3 · Honesty bar (cross-link)

A doc must not claim more than the code guarantees — see [`honesty.md`](./honesty.md). "The SDK synthesizes TTS" when TTS moved server-side, or "X is supported" when the code does less, is an honesty failure, not a typo. The `/audit-docs` method is built on this: every doc claim is verified *against source*, and an unverifiable claim is removed or softened, never left to look authoritative.

---

## What's NOT a rule here

- **"Every code change needs a doc change."** No — most don't (internal refactors, test additions, bug fixes that already match the docs). The obligation fires only when you move a surface a doc *describes*.
- **"Add a CI check / pre-commit grep for stale strings."** Deliberately rejected: maintenance cost + an incomplete denylist gives false confidence. Stale-name grepping lives *inside* `/audit-docs`, where a human judges each hit, not as a standalone gate.
- **"Keep docs exhaustive."** Out of scope. This rule is about *accuracy* of what's documented, not *coverage*.
