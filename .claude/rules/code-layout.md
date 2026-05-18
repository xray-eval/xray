# Code layout

Two rules. Both are about *where* a file lives — not its content. They override default reflexes from other ecosystems (layered architecture, separate `tests/` tree, `__tests__` directories) that show up unprompted.

---

## 1 · Module = vertical slice, not technical layer

Organize the tree by **feature / domain**, not by technical role. One folder per slice; everything that slice needs lives inside it.

**Good** (slices):

```
src/
  server/
    conversations/
      conversations.router.ts
      conversations.service.ts
      conversations.types.ts
      conversations.errors.ts
      conversations.router.test.ts
      conversations.service.test.ts
      conversations.errors.test.ts
      conversations.test-utils.ts
    replays/
      replays.router.ts
      replays.service.ts
      replays.types.ts
      replays.errors.ts
      ...
    otlp/
      otlp.router.ts
      otlp.service.ts
      otlp.types.ts
      otlp.errors.ts
      vocabularies/
        registry.ts
        xray.ts
        gen-ai-semconv.ts
        langfuse.ts
        vocabularies.types.ts
  client/
    conversations/
      conversations.tsx
      conversation-detail.tsx
    inspector/
      inspector.tsx
    replays/
      compare.tsx
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

**Why.** Layered trees couple unrelated features through their shared layer ("I changed `services/foo.ts`, what else broke?"). Slices localize change: editing the conversations feature touches one folder; deleting a vocabulary deletes one file. New contributors find code by *what it does*, not *what kind of code it is*. The vocabulary registry in `src/server/otlp/vocabularies/` is the canonical example — each recognized OTLP vocabulary is one file plus one line in `registry.ts`.

**Edge cases.**
- Genuinely cross-slice code (shared error-response Valibot schemas, the `openApiSchemaFromValibot` helper) lives at `src/server/core/types.ts`. Don't invent a `src/shared/` god-folder.
- A `utils.ts` *inside a slice* is fine. A top-level `src/utils/` is the smell — it means you couldn't find a slice it belongs to, which usually means the slice is missing.
- Inspector sub-components live inside `src/client/inspector/`. There is no `src/hooks/` or top-level `src/components/feature-*`. The only `src/client/components/` folder is `components/ui/` — stock shadcn primitives only.
- **The "service" ban is about top-level folders, not file suffixes inside a slice.** A `src/services/` folder is banned (it pools every API client). But a `src/server/<feature>/<feature>.service.ts` file *inside a feature slice* is allowed when the slice has internal layering — see §3 for the role-suffix convention.

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

Multi-file slices (e.g. the inspector with `inspector.tsx` + sub-component files) keep each implementation file paired with its own `.test.tsx`; **one** shared `types.ts` and **one** shared `test-utils.ts` per slice.

Example — types-only slice:

```
src/server/store/
  types.ts          ← ReplayRow, AssertionStatus, ...
  test-utils.ts     ← makeReplayInput() / makeConversationInput() fixtures
```

Example — logic slice (the OTLP vocabulary registry):

```
src/server/otlp/vocabularies/
  registry.ts       ← ordered SPAN_VOCABULARIES array
  vocabularies.types.ts
  xray.ts
  gen-ai-semconv.ts
  langfuse.ts
```

Example — UI slice (the Conversations index):

```
src/client/conversations/
  conversations.tsx
  conversation-detail.tsx
```

**Why `test-utils.ts` is per-slice, not central.** A central `test/fixtures.ts` becomes a god-file that everyone edits and nobody owns. Per-slice fixtures co-locate the test helper with the type it builds — when the type changes, the fixture builder lives one folder away, not in a separate directory tree. Any test (inside or outside the slice) imports directly: `import { makeReplayInput } from "@/server/store/test-utils.ts"`.

### Alternative — role-suffixed files for slices with internal layering

When a slice has clearly distinct architectural concerns (HTTP router + business logic + types + errors), files within the slice MAY use a **role suffix** instead of the bare convention above. The slice still organizes by feature; the file names just declare which layer they sit at.

| File                       | Purpose                                                            |
|----------------------------|--------------------------------------------------------------------|
| `<slice>.router.ts`        | HTTP wiring, route handlers, error→response mapping                |
| `<slice>.service.ts`       | Pure business logic; no HTTP, testable without a server            |
| `<slice>.types.ts`         | Type definitions + Valibot schemas owned by this slice             |
| `<slice>.errors.ts`        | Typed error classes (per `errors.md`)                              |
| `<slice>.test-utils.ts`    | Fixture builders for this slice's types                            |

Each gets a co-located `.test.ts` next to it.

Example — HTTP endpoint slice:

```
src/server/conversations/
  conversations.router.ts
  conversations.router.test.ts
  conversations.service.ts
  conversations.service.test.ts
  conversations.types.ts
  conversations.errors.ts
  conversations.errors.test.ts
  conversations.test-utils.ts
```

**When to reach for this convention vs. the bare default:**
- Bare default (`types.ts`, `<slice>.ts`, `test-utils.ts`) — slices that don't have a router/service split: types-only slices, pure-logic slices, UI component slices.
- Role-suffixed — server endpoint slices that genuinely have an HTTP layer + a domain-logic layer + typed errors. The suffix has to mean something: `<slice>.service.ts` in a slice with no router is just unused jargon.

**Banned regardless of which convention is used:**
- `services/`, `controllers/`, `routes/` *folders* — that's §1's layered tree.
- Mixing the two conventions inside one slice (`types.ts` next to `conversations.errors.ts`). Pick one per slice.
- A `<slice>.service.ts` that imports Hono or sets HTTP status codes. The point of the split is that the service is HTTP-agnostic.

---

## 4 · No barrel exports

A **barrel file** is an `index.ts` (or similarly-named) whose only job is to re-export the contents of its sibling files:

```typescript
// BANNED — src/server/replays/index.ts
export * from "./replays.router.ts";
export * from "./replays.service.ts";
export * from "./replays.types.ts";
```

**Imports must reference the defining file directly**:

```typescript
// Good
import { createReplaysRouter } from "@/server/replays/replays.router.ts";
import type { ReplayDetailResponse } from "@/server/replays/replays.types.ts";

// Banned
import { createReplaysRouter, type ReplayDetailResponse } from "@/server/replays";
```

**Why.**
- **Bundle size.** `export *` defeats tree-shaking in some bundlers/configurations — pulling one symbol drags in everything the barrel touches.
- **Build time.** Every barrel adds a hop the TS server must follow on hover / go-to-definition / find-references; large barrels visibly slow the editor.
- **Circular imports.** Barrels are the #1 way circular dependencies sneak in: A imports `../shared` (barrel) which imports A. The error message you eventually get is impossible to debug.
- **Discoverability.** "Where is `Agent` defined?" Direct import answers it in one click. Barrel forces a hop.
- **Refactor safety.** Splitting a file behind a barrel is invisible to consumers — fine, but it means the consumer never sees *the actual shape of the slice*. Direct imports keep dependencies legible.

The vertical-slice rule (§1) plus the per-slice convention (§3) already make barrels redundant: a slice IS the unit of cohesion and its file layout is predictable (`types.ts`, `<slice>.ts`, `test-utils.ts`). You don't need an `index.ts` to advertise it. Callers reach into specific files inside the slice (`@/server/conversations/conversations.types.ts`).

**Allowed exception.** None. If you find yourself wanting a barrel, the actual fix is one of: (a) the import sites are too verbose because the slice is too granular — consolidate, or (b) you're crossing a slice boundary that should be a single typed entry point — give that entry point its own file with a real name (`api.ts`, `client.ts`), not `index.ts`.

---

## 5 · One file = one concern. Extract sub-slices when concerns multiply.

A `<slice>.ts` or `<concept>.tsx` should do **one thing**. The moment it handles two or more distinct responsibilities — HTTP wiring AND dispatch AND per-variant business logic; rendering AND state AND I/O; API calls AND response shaping AND caching — extract each into a **sub-slice** (subfolder following the same convention as §3). Not part-1/part-2 splits. Not a `helpers/` dump.

**Triggers, in priority order:**

1. **Multiple responsibilities in one file.** The primary criterion. If you can name two things the file does that could change independently, split now — regardless of LOC. A 120-line file with four responsibilities is worse than a 320-line file with one.
2. **File crosses ~300 lines.** A secondary smell. Long files almost always hide latent responsibilities; the fix is to find them, not to cut by line count.

**Worked example — concern-driven (small file).** An OTLP receiver that handles (a) Hono wiring + error→response mapping, (b) request body parsing/validation, and (c) a vocabulary-registry walk over each span is three responsibilities in one file — even at ~120 lines. Split by role (see §3's role-suffix convention):

```
src/server/otlp/
  otlp.router.ts              ← Hono wiring + body parse + error→HTTP mapping
  otlp.router.test.ts         ← integration tests via app.request()
  otlp.service.ts             ← ingestOtlpTraces: validated request → store rows
  otlp.types.ts               ← Valibot schemas + inferred types
  otlp.errors.ts              ← typed errors
  otlp.errors.test.ts
  otlp.test-utils.ts          ← OTLP request fixture builders
  vocabularies/               ← one file per recognized span vocabulary
    registry.ts
    xray.ts
    gen-ai-semconv.ts
    langfuse.ts
    vocabularies.types.ts
```

`otlp.router.ts` becomes pure HTTP plumbing — testable without touching the store. `otlp.service.ts` is a pure dispatcher — testable without spinning up Hono. Each vocabulary is its own file under `vocabularies/`: adding a fourth vocabulary is a new file plus one line in `registry.ts`, not a refactor.

**Worked example — LOC-driven (long file).**

```
# Day 1 — small
src/server/replays/
  replays.router.ts (180 lines)
  replays.router.test.ts
  replays.service.ts
  replays.types.ts

# Day 14 — replays.service.ts has grown to 450 lines:
#   - createReplay / updateReplay (~150 LOC)
#   - listReplaysForConversation aggregation (~80 LOC)
#   - compareReplays + per-key alignment (~200 LOC)
# Three responsibilities, one file. Extract the bulging ones into sub-slices.

src/server/replays/
  replays.router.ts
  replays.service.ts (180 lines, back down — composes the sub-slices)
  replays.types.ts
  compare/
    compare.ts
    compare.test.ts
    compare.types.ts
```

**Why.** A file with mixed concerns is a slice with mixed concerns — and a mixed slice is a slice nobody owns. Extracting each responsibility gives it its own type surface, test file, and future deletion target. LOC is a heuristic for spotting trouble; *concerns* are the actual unit of cohesion. A 320-line file of one cohesive concept stays as it is; a 120-line file with three responsibilities should split now.

**Anti-patterns to avoid.**
- `adapter-part-1.ts`, `adapter-part-2.ts` — no semantic boundary, just arbitrary cuts.
- `helpers/`, `lib/`, `internal/` — layer thinking sneaking back in. Name the sub-slice after *what it does*, not *what kind of code it is*.
- Splitting on LOC alone when the file does one thing — a 350-line valibot schema for one API surface stays as it is.
- Splitting before responsibilities are real — if a file has 30 lines of one cohesive thing, leave it alone. Wait until you can *name* two responsibilities, not "imagine" two.

---

## What's NOT a rule here

- "One file per export" / "no barrel files" — preference, not a rule.
- "Folder names are kebab-case" — preference, follow what's already there.
- "Components are PascalCase, utilities are kebab-case" — preference.
- Specific test framework — `bun test` is the chosen runner (see `bunfig.toml`); not enforced here.
