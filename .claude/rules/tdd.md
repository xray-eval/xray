# TDD — test first, always

**Write the failing test before you write the code.** Not "with the code", not "after the code is shaped right" — *before*. Every new behavior on this codebase lands as a red→green→refactor cycle. Bug fixes land as a failing regression test plus the fix.

This is a process rule. Tooling alone cannot enforce it — but coverage CI is the safety net (`pnpm test:coverage`, fail-on-drop in `.github/workflows/test.yml`).

---

## The loop

1. **Red.** Write a test that names the behavior you want. Run it. Confirm it fails for the right reason — not because of a typo or missing import, but because the production code does not yet do the thing.
2. **Green.** Write the minimum code to make the test pass. Resist the urge to also handle edge case #2; that's the next red test.
3. **Refactor.** Improve names, deduplicate, restructure. The test suite is your safety net — if you can't refactor with confidence, the tests aren't covering the seam you're touching.

For bug fixes the loop is identical: a failing regression test that reproduces the bug *is* step 1. If you can't reproduce the bug as a test, you don't understand the bug well enough to fix it.

---

## What "test first" means in practice

- **OTLP vocabularies** (`src/server/otlp/vocabularies/<name>.ts`): test each `match(span, resource)` against synthetic projected spans built with the slice's test-utils. The vocabulary registry stays a pure function — no network in tests.
- **Pure logic** (turn-fingerprint canonicalization, attribute flattening, etc.): unit tests with no DOM, no React, no I/O.
- **React components**: test what a user sees and does — render via `@testing-library/react`, query by role/text, click via `userEvent`. No snapshot tests for non-trivial components (they rot, they don't catch regressions).
- **Hono routes**: invoke the Hono `app` directly with a `Request`; do not spin up a real HTTP server.

**Never** mark a test `.skip` / `.todo` to ship faster. Either delete it or fix the code. A skipped test is technical debt with a half-life of forever.

---

## Coverage gates

The CI `test` job in `.github/workflows/test.yml` runs `pnpm test:coverage` (→ `bun test --coverage`) and fails the build if:

- Line coverage drops below the threshold in `bunfig.toml` (`[test].coverageThreshold.line`).
- Function or statement coverage drops below the threshold.

**Coverage is a sanity floor, not a target.** 100% coverage doesn't mean the tests are good; it means everything ran. The threshold exists to flag "you added 200 lines of code without a single test" — the human reviewer judges quality.

If a PR drops coverage, the fix is to add tests, not to lower the threshold. Lowering the threshold requires a written justification in the commit message — same bar as relaxing a supply-chain setting (`.claude/rules/supply-chain.md`).

---

## What's NOT a rule here

- "100% coverage required" — preference, and a misleading one. The threshold lives in `bunfig.toml` and is intentionally tuned to "no new untested code", not "every line covered".
- "One assertion per test" — preference; do whatever reads clearly.
- "BDD-style `describe`/`it` vs. flat `test`" — preference; `bun test` accepts both.
- "Mock everything" — actively bad. Prefer real implementations and fixtures; mock at the I/O boundary (provider SDK, fetch) only.
