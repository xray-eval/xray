---
description: Audit the prose docs against the actual code and fix any drift, treating every doc claim as untrusted until verified against source
---

Audit xray's prose documentation against the current code and bring it back in
sync. The governing rule is [`.claude/rules/docs-freshness.md`](../rules/docs-freshness.md)
— read it first for the source → doc map.

**Premise: every doc claim is untrusted until verified against source.** A
markdown table, a docstring, a code example — all are claims about the code, not
the code itself. Do not trust a doc because it reads confidently. Open the
source and confirm.

## Scope

`$ARGUMENTS` may narrow the audit to one area (e.g. `sdk`, `wire-contract`,
`schema`). If empty, audit the full set:

- `docs/` — `index.md`, `architecture.md`, `integrate.md`, `sdk-python.md`, `wire-contract.md`
- `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`
- `sdk/python/README.md`, `sdk/python/.claude/rules/typed-boundaries.md`

If a commit range is given (e.g. `since main`), use `git diff` to find which
source files moved and audit only the docs the map couples them to — a targeted
pre-PR pass.

## Method

1. **Walk the source → doc map** in the freshness rule. For each doc in scope,
   list its concrete claims: exported names, signatures, enum values, table
   counts, env var names + defaults, API routes, limits, status codes, file
   paths, code examples.
2. **Verify each claim against source** — Read the file, Grep the symbol. Pick
   the highest-signal ground truth:
   - SDK public surface → `sdk/python/src/xray/__init__.py` (`__all__`) + the
     dataclass / function defs in `conversation.py`, `config.py`, `errors.py`,
     `instrument.py`, `orchestrator.py`, `runtime/*`.
   - Storage / enums → `src/server/store/schema.ts` (`lifecycle_state`,
     `analysis_step`, `failure_reason`, table list).
   - OTLP vocabularies / extraction → `src/server/otlp/vocabularies/*`.
   - Limits + error shapes → `src/server/otlp/otlp.types.ts`, `otlp.router.ts`.
   - Env vars → `src/server/env/env.ts`.
3. **Stale-name sweep.** Grep the doc set for names the code no longer exports
   (the highest-confidence drift). Judge each hit — a legitimate "renamed from
   X" migration note is fine; a live reference to a dead symbol is not.
4. **Check cross-links.** Every relative markdown link and `github.com/.../blob`
   link must resolve. `docs/` is built into a static site by VitePress
   (`docs/.vitepress/config.mts`, `base: '/xray/'`) and deployed to GitHub Pages by
   `.github/workflows/docs.yml`. In-docs `./*.md` links are fine — VitePress
   rewrites them and they also resolve on GitHub. Links that escape `docs/` (to
   source files or other repo paths) must use the full `github.com/.../blob` URL,
   not `../`, since those resolve on GitHub but not on the built site.
5. **Honesty pass** ([`honesty.md`](../rules/honesty.md)). Flag any claim that
   says *more* than the code guarantees, not just outright-wrong ones. Over-claims
   are the subtle drift.

## Fix

Apply the corrections directly. For each fix, the doc must now match a specific
line of source you can point to. If a claim can't be verified, remove or soften
it rather than leaving it authoritative.

## Report

End with a short summary grouped by severity:

- **Wrong** — a flat-out false claim a reader would act on (fixed).
- **Over-claim** — says more than the code guarantees (fixed/softened).
- **Stale link / name** — dead reference (fixed).
- **Checked, fine** — a claim you verified that turned out correct (list briefly,
  so the audit's coverage is legible — per [`honesty.md`](../rules/honesty.md) §3,
  don't claim you audited what you didn't).

Do not commit or push unless asked — leave the working tree for review.
