# Validate untrusted data at the boundary, with a codec

**Every byte that crosses into our code from a system we don't control passes through a runtime schema check before any other code reads it.** The check produces a value with a precise static type *and* a runtime guarantee — never one without the other.

The failure mode this prevents: an adapter writes `const data: T = await response.json();` (banned by `no-as-cast.grit` + this rule together), the API changes a field from `string` to `string | null`, the adapter silently returns half-constructed objects with `null` where the static type says `string`, the UI renders `undefined`, the bug surfaces in production a week later. The TS type was a lie because nothing checked it.

This rule lives separately from [`errors.md`](./errors.md) (which governs *how* we throw) and [`code-layout.md`](./code-layout.md) (which governs *where* code lives) because it governs a different question: *when do we validate*.

---

## 1 · Boundaries

A **boundary** is any value entering the program from outside the bytes we shipped:

| Boundary                                | Validate before use? |
|-----------------------------------------|----------------------|
| OTLP/HTTP trace request bodies (from any agent's exporter) | **Yes** |
| Hono request bodies + query params (SDK control plane: conversations, replays, audio) | **Yes** |
| Env vars consumed by the server          | **Yes** (parse once at startup) |
| Files / JSON we read at runtime          | **Yes** |
| Browser inputs handed to the API         | **Yes** (client-side) |
| Return values from our own typed code    | No — the type is the proof |
| Bun build-time env (`Bun.env` at bundle time) | No — frozen at build |

If you're inside a slice consuming a typed value produced by another slice in this repo, the boundary was already crossed. Don't double-validate.

---

## 2 · Codec library: Valibot

Pinned choice: **valibot ≥ 1.3.1**. Reasons, in priority order:

- **Tree-shakeable.** Modular function exports (`v.object`, `v.string`, `v.parse`) — bundlers drop unused validators. Matters for the React SPA bundle; doesn't hurt on the server.
- **Schemas are the source of truth.** Define once: `const Schema = v.object({...})` → `type T = v.InferOutput<typeof Schema>`. One artifact, two purposes — never out of sync.
- **Standard Schema compliance.** Plays with TanStack Form, tRPC, Hono validators, and future Anthropic/OpenAI SDK validators without per-tool adapters.

Not Zod: ~5–10× larger bundle and an OO-chaining API that resists tree-shaking. Not ArkType: type-string DSL is a separate language to learn; modest performance win doesn't pay for the cognitive cost on this team. Re-litigate only if Valibot stops being maintained or a Standard-Schema-compliant alternative wins decisively.

---

## 3 · Where the schemas live

Per [`code-layout.md`](./code-layout.md) §3: in the slice that owns the boundary.

```
src/server/otlp/
  otlp.types.ts      ← OTLP/JSON Valibot schemas + `v.InferOutput` type aliases
  otlp.router.ts     ← imports schemas, calls v.safeParse at the HTTP edge
  otlp.service.ts    ← projects the parsed request through the vocab registry
  otlp.errors.ts     ← InvalidOtlpBodyError (carries issues)
```

The `*.types.ts` file becomes "schemas + their inferred types", not "hand-written interfaces". You almost never write `interface FooResponse { ... }` — you write `const FooResponseSchema = v.object({...})` and export `type FooResponse = v.InferOutput<typeof FooResponseSchema>`.

For other server endpoints, the same shape:

```
src/server/conversations/
  conversations.router.ts    ← Hono router; v.safeParse at the body edge
  conversations.service.ts
  conversations.types.ts     ← request/response schemas + inferred types
  conversations.errors.ts    ← InvalidConversationRequestError, etc.
```

---

## 4 · The pattern

**Inside the route / service, at the boundary:**

```ts
const raw: unknown = await c.req.json();              // 1. unknown — never typed by fiat
const result = v.safeParse(SomeRequestSchema, raw);   // 2. validate + narrow
if (!result.success) {
  throw new InvalidRequestError(result.issues);
}
return result.output;                                 // 3. typed value, proven shape
```

Use `v.safeParse` (returns a discriminated union), not `v.parse` (throws a `ValiError` with no domain context). The thrown error must be a typed subclass per [`errors.md`](./errors.md), with a `readonly issues: readonly BaseIssue<unknown>[]` field so callers and the inspector UI can surface the failure cause.

**Banned shortcuts:**

- `const data: T = await response.json()` — silently lies; type is unverified.
- `(await response.json()) as T` — banned by `no-as-cast.grit` and this rule.
- Validating in the consumer instead of at the boundary — by then the lie has propagated.
- One mega-schema for "the whole API" — schemas live per-route, per-endpoint, in the slice that consumes them.
- `v.looseObject` "to be safe" — only when we deliberately want to preserve unknown keys. Default to `v.object` which strips them.

---

## 5 · Tests

Each schema gets:

- One **happy-path test** that asserts `v.parse(Schema, validFixture)` returns the expected shape — the fixture is the documented API response.
- One **negative test** at the slice level: feed the adapter/route a malformed payload, assert it throws the typed `*InvalidResponseError`. This is the test that catches schema drift.

The negative test goes in `adapter.test.ts` / `<route>.test.ts`, not in `types.test.ts`. The schema's job is checked indirectly through the slice's behavior — that's where the contract lives.

---

## What's NOT a rule here

- "Use Valibot for everything" — no, **at the boundary**. Internal pure logic does not validate every function call.
- "Schemas must cover every field the API returns" — model only what we consume. Fields we ignore stay ignored. Adding a field is a one-line change next to where it's used.
- "Branded types / opaque IDs" — separate decision; possible future rule when ID confusion bites us.
- "Server-side input validation framework choice (Hono's validator middleware vs raw `v.safeParse`)" — convention, pick on first server route; the rule above already mandates the underlying codec.
