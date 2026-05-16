# Use the shadcn CLI — never hand-roll primitives that exist in the registry

**Any UI primitive that exists in the [shadcn registry](https://ui.shadcn.com/docs/components) lands in `src/client/components/ui/` via `pnpm dlx shadcn@<pinned> add <name>` — never by hand-writing the file. Stock CLI output is the contract; customization happens at the call site via `className`, not by rewriting the primitive's source.**

The failure mode this prevents: an LLM session needs a `Card`, decides "I know what a card looks like, I'll just write the file," produces a divergent component with bespoke variants like `padding="row" | "panel" | "feature"` and a `<CardLabel>` slot that doesn't exist in shadcn. The file looks fine in isolation — but the day someone runs `pnpm dlx shadcn add input` or `shadcn add dialog`, the new primitive composes against shadcn's canonical slot shape (`<Card><CardHeader><CardTitle>`), not the bespoke API. Every future primitive then needs manual reconciliation, the codebase stops looking like a shadcn project to anyone joining it, and the value of using shadcn (free updates, tutorials that match, every example in the ecosystem) evaporates.

Even subtler failure: rewriting the primitive's file to "extend" it (additive CVA variants, extra slots) feels harmless and was the previous version of this rule. In practice it drifts — the next `shadcn add card` overwrites the file silently and the extensions are lost without a three-way merge nobody is going to do. Cleaner contract: **stock output stays stock. Custom needs live at the call site.**

---

## 1 · The workflow

When you reach for a UI primitive:

1. **Check the registry.** Is it at `https://ui.shadcn.com/docs/components`? If yes → CLI. If no, see §3.
2. **Pin the CLI version** to the latest release that clears the 7-day cooldown:
   ```bash
   pnpm dlx shadcn@<pinned-version> add <component>
   ```
   Never `pnpm dlx shadcn@latest` — `latest` could be < 7 days old and that bypasses the supply-chain rule.
3. **Let the CLI write the file.** Do not pre-create. Do not "fix" the formatting before biome runs.
4. **Run `pnpm check:fix`** to apply project formatting (tabs, semicolons, biome organize-imports).
5. **Fix the `cn` import path.** The CLI generates `import { cn } from "@/client/lib/utils"` (no extension). This project requires `.ts` everywhere for consistency:
   ```bash
   sed -i '' 's|"@/client/lib/utils"|"@/client/lib/utils.ts"|g' src/client/components/ui/<name>.tsx
   ```

## 2 · Customizing without touching the primitive

The CLI's output exposes:
- **Variant props** (`variant`, `size`, `tone`, etc.) typed via CVA.
- **A `className` escape hatch** that goes through `cn(...)` → `tailwind-merge`, so caller-side classes override stock ones cleanly.

Almost any visual need fits one of:

- **Use a different stock variant.** `<Button variant="outline">`, `<Badge variant="secondary">`. Read the file once to know what's available; reach for those before anything else.
- **Pass `className`** for spacing, layout, or page-specific adjustments. tailwind-merge handles the override:
  ```tsx
  <Card className="gap-0 py-4 shadow-none">...</Card>
  ```
- **Compose at a higher level.** If the same `<Card className="...">` shape repeats five times, that's a *feature component* (§3) — extract it as a slice, not as an "extended primitive."

If none of those work — e.g. you genuinely need a new variant axis that doesn't exist in shadcn — open the discussion separately. Don't pre-emptively edit the file; the cost is rarely worth it.

## 3 · When the registry doesn't have what you need

If the primitive truly doesn't exist (e.g. xray's `ConversationRow`, `ToolCallSidebar`), build it as a **slice component** following the rest of `code-layout.md` — in its own slice folder under `src/client/<feature>/`, not under `components/ui/`. The `components/ui/` folder is reserved for unmodified shadcn primitives; everything else is feature code that *composes* those primitives.

A slice component is allowed to wrap shadcn primitives with feature-specific layout and styles via `className`. That's the right place for feature aesthetics.

## 4 · Updating an existing primitive

To pull a newer shadcn release:

```bash
pnpm dlx shadcn@<new-version> add <component> --yes --overwrite
# Then re-run the cn-import-path sed and biome check:fix.
```

Because the file is stock, no merge is needed.

## 5 · What's banned

- Hand-writing a file under `components/ui/` whose name matches a registry primitive (`button.tsx`, `card.tsx`, `dialog.tsx`, etc.). Even "as a placeholder until we run the CLI" — the placeholder always becomes permanent.
- Deleting stock slot exports (`CardHeader`, `CardTitle`, etc.) the current UI doesn't use. They cost nothing and are load-bearing for future composability.
- `pnpm dlx shadcn@latest` without a pinned version. Use the pinned form per §1.

---

## What's NOT a rule here

- **"Every shadcn primitive must be installed up front."** No — install on demand.
- **"Never customize the look of a component."** False — customize at the call site with `className` and stock variants. That's the supported extension point.
- **"Use shadcn for feature UI."** No — feature components (a session list, a tool-call inspector) are slice code under `src/client/<feature>/`, not primitives. The CLI is for primitives only.
