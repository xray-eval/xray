# One bundler — Bun builds everything the browser runs

**Every line of client code that reaches a browser is bundled by Bun's HTML bundler — production (`scripts/build.ts`), dev (`bun --hot`), and the Cosmos component workbench (`cosmos/serve-renderer.ts`) alike. Do not add a second bundler to that path.**

The failure mode this prevents: a session wants to look at a component in isolation, reaches for the tool everyone reaches for, and installs Storybook — or Ladle, or Histoire, or Cosmos's own Vite integration. Each one works. Each one looks reasonable in review, because a devDependency that only runs locally seems free. What it actually buys is a **second bundler that renders your components differently from the one that ships them**, and a workbench whose entire purpose is to tell you what a component looks like now answers for a build nobody deploys.

This is not the same rule as [`single-image-distribution.md`](./single-image-distribution.md) — that one governs the runtime artifact. This one governs the build path.

---

## 1 · Why Cosmos and not Storybook

Measured on 2026-07-31, resolving each into a throwaway lockfile:

| Tool | Packages added | Bundler | Bun support |
|---|---|---|---|
| `storybook` + `@storybook/react-vite` | 284 | Vite / webpack / Rspack only | **No Bun builder.** [oven-sh/bun#3794](https://github.com/oven-sh/bun/issues/3794) open since 2023; Storybook's own [compatibility tracker](https://github.com/storybookjs/storybook/issues/23279) lists Bun as ⚠️ experimental |
| `@ladle/react` | **469** | Vite + Babel | No — and no release in 9 months as of that date |
| `histoire` | — | Vite, Vue-first | No — still `1.0.0-beta.1` |
| **`react-cosmos` + `react-cosmos-dom`** | **166** (138 after dedupe here) | **none — bring your own** | **Yes** |

React Cosmos ships no bundler at all. Its [custom bundler mode](https://reactcosmos.org/docs/getting-started/custom-bundler) splits the tool into a server, a UI, and a renderer you serve yourself — which is why Bun can serve it and why it is the one that fits here.

## 2 · What's banned

- Adding Storybook, Ladle, Histoire, or any workbench that requires Vite/webpack/Rspack.
- Switching Cosmos off custom-bundler mode — `cosmos --builder vite`, `@cosmos-config/vite`, or following Cosmos's Vite/webpack getting-started page instead of the custom-bundler one.
- Any `vite.config.*` / `webpack.config.*` under `src/` or `cosmos/`.
- A bundler in `dependencies` or `devDependencies` that isn't Bun.

**Not banned:** `vite` is already in the lockfile as a transitive dependency of `vitepress`, which builds the docs site at `docs/`. That's a separate artifact that ships no application code, and it's fine. The rule is about the path from `src/client/**` to a browser.

## 3 · How to spot a violation

Any of these in a diff is the smoke signal:

- a new `vite`, `webpack`, `rspack`, `@storybook/*`, or `@ladle/*` entry in `package.json`
- a `builder` key appearing in `cosmos.config.json`
- `cosmos/serve-renderer.ts` no longer importing `./index.html`

## 4 · If Bun's bundler genuinely can't do it

Then that's a product-level conversation in an issue — the same bar as [`single-image-distribution.md`](./single-image-distribution.md) §3. "Bun's bundler doesn't support X" is a reason to file the Bun issue and work around it, not a reason a second toolchain quietly appears in a PR that was about something else.

---

## What's NOT a rule here

- **"Never add dev tooling."** False — this is about bundlers specifically. Linters, test runners, and type checkers are unaffected.
- **"React Cosmos specifically."** The rule is the *property* (one bundler, and it's Bun). If a better Bun-compatible workbench appears, swap it.
- **"Never install anything with a large dependency tree."** Package count is evidence here, not the rule. 166 packages would still have been wrong if they'd brought a second bundler.
