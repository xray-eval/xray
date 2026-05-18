# Never silence the linter — fix the code

**No `// biome-ignore`, no `// biome-ignore-all`, no `// eslint-disable-*`, no `/* @ts-expect-error */`, no `// @ts-ignore`, no `// @ts-nocheck` in `src/`, `scripts/`, or `biome-plugins/`.** When the linter flags something, change the code so the lint passes naturally.

The failure mode this prevents: an LLM session hits a lint warning, papers over it with `// biome-ignore lint/X/Y: short note`, repeats that pattern through the codebase, and the suppressions accumulate faster than anyone can audit them. Each ignore is a tiny `# nosec` — individually defensible, collectively a way for real bugs to ride along under "won't this rule pass?" The lint config is the contract; suppressing it locally breaks the contract one line at a time.

The rules in `biome.json` (`no-as-cast`, `noFloatingPromises`, `noNonNullAssertion`, `useImportType`, `useExhaustiveDependencies`, `noShadow`, the a11y bundle, …) were each chosen for a reason that's at minimum one line of justification. The cost of working around them — restructuring the code, adding a captions track, using a discriminated union — is the cost the codebase signed up for.

---

## 1 · The four banned mechanisms

| Mechanism | Banned? |
|---|---|
| `// biome-ignore lint/X/Y: …` | **Yes**, in every form (single-line, JSX `{/* */}`, multi-line) |
| `// biome-ignore-all lint/X/Y: …` (file-top) | **Yes** |
| `// eslint-disable…` (any variant) | **Yes** — we don't use ESLint, so any such comment is dead code anyway |
| `// @ts-ignore`, `// @ts-expect-error`, `// @ts-nocheck` | **Yes** — the TypeScript equivalent. Same problem, same fix. |

---

## 2 · What to do instead — by rule kind

The vast majority of lint failures resolve to one of these moves. If you're tempted to suppress, you almost always meant one of the below:

- **`lint/a11y/*`** — fix the actual accessibility issue. For `useMediaCaption`, attach an inline `<track kind="captions">` whose `src` is a `data:text/vtt;…` URL built from text already in the model (e.g. the turn's transcript). Don't pretend the rule doesn't apply.
- **`lint/correctness/useExhaustiveDependencies`** — list the missing dep, or restructure so the effect doesn't depend on it. If the effect shouldn't run on that change, the effect itself is wrong (see [`no-effect-for-data.md`](../../src/client/.claude/rules/no-effect-for-data.md)).
- **`lint/style/noNonNullAssertion`** — narrow with `if (x === undefined) throw new …`, or parse at a boundary so the type comes back non-null (see [`boundary-validation.md`](./boundary-validation.md)).
- **`lint/style/useImportType`** — split the import statement (Biome's safe fix does this for free).
- **`lint/correctness/noUnused…`** — delete the unused symbol. If you "might need it later", that's the future's problem; YAGNI.
- **`lint/nursery/noFloatingPromises`** — `await` it, `void` it intentionally (and only if fire-and-forget is correct — see fire-and-forget paragraph below), or store the promise for cleanup.
- **`lint/nursery/noShadow`** — rename one of the bindings.
- **`no-as-cast`** (custom plugin) — parse with Valibot, narrow with a type guard, or use `ts-pattern`. See the rule directly in `biome-plugins/no-as-cast.grit`.

If the linter is genuinely wrong about your case, the fix is **change the rule's config in `biome.json`** with a justification in the commit message — not a per-site suppression. A rule we've decided shouldn't apply to a specific file pattern can be scoped via `overrides` in `biome.json`. Either we want the rule or we don't; we don't want it case-by-case in source files.

---

## 3 · `void promise` is allowed; `// biome-ignore noFloatingPromises` is not

Fire-and-forget is a real pattern (background telemetry posts, dev-script logging). The legitimate form is:

```ts
void pushTelemetrySpan(replayId, attributes);
```

`void` is a *language feature* that says "I know this returns a promise; I'm intentionally not awaiting." `biome-ignore` is a *linter feature* that says "shut up about this." They aren't equivalent — the first is intent expressed in code, the second is intent expressed by silencing the tool that was checking the code.

---

## 4 · `as const` is not an `as` cast

For completeness: `as const` is a literal-type widening control, not a type assertion. It's allowed and necessary (e.g. `[...] as const satisfies readonly T[]`). The `no-as-cast.grit` plugin already excludes it.

---

## 5 · Migration

When you encounter an existing `biome-ignore` (or any of the banned mechanisms) in a file you're already editing, remove it in the same PR — same "fix in passing" reflex as in [`pattern-matching.md`](./pattern-matching.md) §4 and [`comments.md`](./comments.md) §4. Don't open a side-PR for a suppression-only sweep unless the cleanup is the explicit task.

---

## What's NOT a rule here

- **"Never use `@ts-expect-error` in test files"** — same rule. Tests live under `src/<slice>/<file>.test.ts` per [`code-layout.md`](./code-layout.md); the rules apply everywhere.
- **"Suppression in third-party generated code"** — out of scope; `src/server/store/migrations/` is excluded in `biome.json` already.
- **"Disable linter rules globally to make work easier"** — the opposite. The rule is "either keep the rule and make the code conform, or change the rule in config with a written reason — never suppress at the call site."
