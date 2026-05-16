# Code layout

Two rules. Both are about *where* a file lives — not its content. They override default reflexes from other ecosystems (layered architecture, separate `tests/` tree, `__tests__` directories) that show up unprompted.

---

## 1 · Module = vertical slice, not technical layer

Organize the tree by **feature / domain**, not by technical role. One folder per slice; everything that slice needs lives inside it.

**Good** (slices):

```
src/
  adapters/
    elevenlabs/
      adapter.ts
      adapter.test.ts
      types.ts
      signed-url.ts
      signed-url.test.ts
    registry.ts
    types.ts
  graph/
    workflow-graph.tsx
    workflow-graph.test.tsx
    node.tsx
    edge.tsx
  inspector/
    inspector.tsx
    inspector.test.tsx
    format-tool-call.ts
    format-tool-call.test.ts
```

**Bad** (layers):

```
src/
  components/    ← every UI component lumped together
  hooks/         ← every hook lumped together
  services/      ← every API client lumped together
  types/         ← every type definition lumped together
  utils/         ← the death pile
```

**Why.** Layered trees couple unrelated features through their shared layer ("I changed `services/foo.ts`, what else broke?"). Slices localize change: editing the graph feature touches one folder; deleting a provider deletes one folder. New contributors find code by *what it does*, not *what kind of code it is*. The adapter pattern in this repo is the canonical example — `src/adapters/elevenlabs/` is the entire ElevenLabs feature.

**Edge cases.**
- Genuinely cross-slice code (shared types like `Agent`, `Workflow`; the adapter registry) lives at the parent level (`src/adapters/types.ts`, `src/adapters/registry.ts`). Don't invent a `src/shared/` god-folder.
- A `utils.ts` *inside a slice* is fine. A top-level `src/utils/` is the smell — it means you couldn't find a slice it belongs to, which usually means the slice is missing.
- React-Flow nodes, hooks, and component logic for the graph all live in `src/graph/`. There is no `src/hooks/` or `src/components/`.

## 2 · Tests live next to the file they test

A test file lives in the **same folder** as the source file, with the same base name plus `.test.ts(x)`:

- `adapter.ts` → `adapter.test.ts`
- `workflow-graph.tsx` → `workflow-graph.test.tsx`

**Banned:**
- A top-level `tests/` or `test/` mirror tree.
- `__tests__/` subfolders (Jest convention — irrelevant here, we use Bun's test runner).
- `*.spec.ts` (pick one suffix; we use `.test.ts`).

**Why.**
- **Rename safety.** Renaming `foo.ts` → `bar.ts` moves its test in the same operation. With a mirror tree, the test gets stranded and is silently forgotten.
- **Discoverability.** Open a folder, see what's tested. No "the test is *somewhere* in `tests/`" hunt.
- **Slice cohesion.** A slice should be a self-contained unit you can copy or delete. Tests are part of the slice.
- **Delete confidence.** Removing a feature = `rm -rf src/<feature>/`. If tests lived elsewhere, you'd leave orphan tests that pass against deleted code (worst case: keep passing because they test a removed export that's now `undefined`).

The Bun test runner picks up `**/*.test.{ts,tsx}` by default — no config needed.

---

## 3 · Each slice folder follows the same file convention

Inside any slice folder:

| File              | Purpose                                                          | When to omit                              |
|-------------------|------------------------------------------------------------------|-------------------------------------------|
| `types.ts`        | Type definitions owned by this slice                             | Slice has no types                        |
| `<slice>.ts`      | Implementation: functions, classes, components, hooks            | Slice is types-only                       |
| `<slice>.test.ts` | Co-located tests for `<slice>.ts`                                | No implementation to test                 |
| `test-utils.ts`   | Fixture builders, mock factories, suite helpers FOR this slice's types | Slice has nothing reusable in tests |

Multi-file slices (e.g. `graph/` with `graph.tsx` + `node.tsx` + `edge.tsx`) keep each implementation file paired with its own `.test.tsx`; **one** shared `types.ts` and **one** shared `test-utils.ts` per slice.

Example — types-only slice:

```
src/adapters/agent/
  types.ts          ← Agent, AgentId
  test-utils.ts     ← makeAgent() fixture
```

Example — logic slice:

```
src/adapters/registry/
  registry.ts       ← registerAdapter, getAdapter, listAdapters
  registry.test.ts  ← unit tests
  test-utils.ts     ← useCleanRegistry() suite helper
```

Example — UI slice:

```
src/graph/
  types.ts          ← GraphNode, GraphEdge, GraphProps
  graph.tsx
  graph.test.tsx
  node.tsx
  node.test.tsx
  edge.tsx
  edge.test.tsx
  test-utils.ts     ← renderGraphWithFlow(), makeGraphProps()
```

**Why `test-utils.ts` is per-slice, not central.** A central `test/fixtures.ts` becomes a god-file that everyone edits and nobody owns. Per-slice fixtures co-locate the test helper with the type it builds — when the type changes, the fixture builder lives one folder away, not in a separate directory tree. Any test (inside or outside the slice) imports directly: `import { makeAgent } from "@/adapters/agent/test-utils.ts"`.

---

## 4 · No barrel exports

A **barrel file** is an `index.ts` (or similarly-named) whose only job is to re-export the contents of its sibling files:

```typescript
// BANNED — src/adapters/index.ts
export * from "./adapter.ts";
export * from "./agent.ts";
export * from "./conversation.ts";
export * from "./workflow.ts";
```

**Imports must reference the defining file directly**:

```typescript
// Good
import type { VoiceAgentAdapter } from "@/adapters/adapter.ts";
import type { Agent } from "@/adapters/agent.ts";

// Banned
import type { VoiceAgentAdapter, Agent } from "@/adapters";
```

**Why.**
- **Bundle size.** `export *` defeats tree-shaking in some bundlers/configurations — pulling one symbol drags in everything the barrel touches.
- **Build time.** Every barrel adds a hop the TS server must follow on hover / go-to-definition / find-references; large barrels visibly slow the editor.
- **Circular imports.** Barrels are the #1 way circular dependencies sneak in: A imports `../shared` (barrel) which imports A. The error message you eventually get is impossible to debug.
- **Discoverability.** "Where is `Agent` defined?" Direct import answers it in one click. Barrel forces a hop.
- **Refactor safety.** Splitting a file behind a barrel is invisible to consumers — fine, but it means the consumer never sees *the actual shape of the slice*. Direct imports keep dependencies legible.

The vertical-slice rule (§1) plus the per-slice convention (§3) already make barrels redundant: a slice IS the unit of cohesion and its file layout is predictable (`types.ts`, `<slice>.ts`, `test-utils.ts`). You don't need an `index.ts` to advertise it. Callers reach into specific files inside the slice (`@/adapters/agent/types.ts`).

**Allowed exception.** None. If you find yourself wanting a barrel, the actual fix is one of: (a) the import sites are too verbose because the slice is too granular — consolidate, or (b) you're crossing a slice boundary that should be a single typed entry point — give that entry point its own file with a real name (`adapter.ts`, `client.ts`), not `index.ts`.

---

## 5 · When a file gets long, extract a submodule

When a `<slice>.ts` or `<concept>.tsx` crosses **~300 lines**, the fix is to extract the bulging responsibility into a **sub-slice** (subfolder following the same convention as §3), not to split the file into part-1/part-2 or to dump helpers into a `helpers/` folder.

Example progression:

```
# Day 1 — small
src/adapters/elevenlabs/
  adapter.ts (180 lines)
  adapter.test.ts
  types.ts
  test-utils.ts

# Day 14 — adapter.ts has grown to 450 lines:
#   - listAgents/getWorkflow (~150 LOC)
#   - live conversation (~200 LOC: SDK wiring, event mapping, mic lifecycle)
#   - signed URL minting (~100 LOC)
# Three responsibilities, one file. Extract the bulging ones into sub-slices.

src/adapters/elevenlabs/
  adapter.ts (180 lines, back down — just composes the sub-slices)
  adapter.test.ts
  types.ts
  test-utils.ts
  live/
    live.ts
    live.test.ts
    types.ts
    test-utils.ts
  signed-url/
    signed-url.ts
    signed-url.test.ts
    types.ts
```

**Why.** Long files almost always hide latent slices — distinct responsibilities sharing a filename. Extracting them gives each its own type surface, test file, and future deletion target. The 300-line threshold is a smell trigger, not a hard limit: a 320-line file of one cohesive concept stays as it is; a 250-line file with two unrelated halves should split now.

**Anti-patterns to avoid.**
- `adapter-part-1.ts`, `adapter-part-2.ts` — no semantic boundary, just arbitrary cuts.
- `helpers/`, `lib/`, `internal/` — layer thinking sneaking back in. Name the sub-slice after *what it does*, not *what kind of code it is*.
- Pre-emptive splits at 100 lines — premature submodule = code in search of a concept. Wait for the actual pressure.

---

## What's NOT a rule here

- "One file per export" / "no barrel files" — preference, not a rule.
- "Folder names are kebab-case" — preference, follow what's already there.
- "Components are PascalCase, utilities are kebab-case" — preference.
- Specific test framework (Bun test vs. Vitest) — chosen elsewhere, not enforced here.
