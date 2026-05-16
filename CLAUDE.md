# xray

**Voice Agent X-Ray** — open-source, self-hosted web debugger for voice-agent workflows. Public repo. Vite + React + TypeScript SPA, Hono on Bun for the proxy backend, Docker (multi-stage) for distribution. Adapter pattern for voice-agent providers — the core app stays provider-agnostic; each provider is one file under `src/adapters/`. No accounts, no database, no persistence outside the browser session.

**Distribution.** The shipped artifact is a Docker image published to **GHCR** (`ghcr.io/<owner>/xray`) by CI on tagged releases. Operators `docker pull` and run it. No SaaS, no hosted version.

**Local-first.** Every CI step must be runnable on a developer machine with one command — image build, image run + smoke test, supply-chain audit, lint, typecheck. CI runs the same scripts; it doesn't have privileged knowledge. If something only works in GitHub Actions, that's a bug.

## Rules

@.claude/rules/honesty.md
@.claude/rules/code-layout.md
@.claude/rules/errors.md
@.claude/rules/tdd.md
@.claude/rules/supply-chain.md
@.claude/rules/public-repo.md

## When to write a new rule

A rule under `.claude/rules/` exists to prevent a concrete repeat mistake by future Claude sessions. **All four** of the following must hold before creating one:

1. **Concrete failure mode.** You can name the mistake in one sentence ("Claude runs `npm install` instead of pnpm and trips `only-allow`"). If you can't, it's not a rule.
2. **Not already enforced by code, config, lint, type, test, or CI.** If a `preinstall` guard, an ESLint rule, a `tsconfig` flag, or a CI check already enforces it, *that file is the rule* — don't duplicate it here.
3. **Non-obvious *why*.** Anything obvious from reading the codebase doesn't need a rule. The value is in the reasoning ("7-day cooldown because Shai-Hulud" — not "use pnpm").
4. **Hard constraint, not a preference.** If a reasonable person could disagree on a Tuesday and it'd be fine, it belongs in a CLAUDE.md narrative or a PR description, not in `.claude/rules/`.

When in doubt: don't write the rule. A missing rule is recoverable (the user will correct you); a sprawl of overlapping rules is not.

### Maintenance

- One topic per file. If two rules cover the same topic, merge them.
- Drop a rule once the thing it warns about is enforced by code/CI.
- Cross-link with relative paths; never let contradictory rules accumulate.
