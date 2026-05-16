# Errors are typed classes, not strings

**Every `throw` in `src/` throws an `Error` subclass, never a raw `new Error("...")`.** The thing being thrown carries a static type, a stable `.name`, and any structured data the caller might need. Callers discriminate via `instanceof` (which narrows the type — no `as` cast needed, see [`code-layout.md`](./code-layout.md) and the banned-`as`-cast plugin).

The failure mode this prevents: someone writes `throw new Error("Adapter for provider \"elevenlabs\" is already registered")`, a route handler later wants to map it to a 409, the only way to detect it is `String(e.message).includes("already registered")`. The message is now load-bearing — renaming it breaks the handler silently. Worse, two unrelated errors that happen to share a substring collide.

---

## 1 · Shape

Every error slice has:

- One **base class** named after the slice's domain (`AdapterError`, `ProxyError`, `WorkflowError`). Extends `Error`. Sets `this.name` in the constructor.
- One **subclass per semantically distinct failure** (`DuplicateAdapterError`, `UnknownProviderError`, `MissingApiKeyError`). Each extends the base. Each sets its own `this.name` and exposes any structured data as `readonly` fields.

Canonical shape (see `src/adapters/errors/errors.ts`):

```ts
export class AdapterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdapterError";
  }
}

export class DuplicateAdapterError extends AdapterError {
  readonly provider: ProviderId;
  constructor(provider: ProviderId) {
    super(`Adapter for provider "${provider}" is already registered`);
    this.name = "DuplicateAdapterError";
    this.provider = provider;
  }
}
```

Callers narrow without casting:

```ts
try { registerAdapter(...) }
catch (e) {
  if (e instanceof DuplicateAdapterError) {
    // e.provider is typed as ProviderId here — no cast
    return Response.json({ error: "duplicate", provider: e.provider }, { status: 409 });
  }
  if (e instanceof AdapterError) { /* generic adapter-layer failure */ }
  throw e;
}
```

Pairs cleanly with `ts-pattern`:

```ts
match(e)
  .with(P.instanceOf(DuplicateAdapterError), (err) => ...)
  .with(P.instanceOf(AdapterError), (err) => ...)
  .otherwise(() => { throw e });
```

---

## 2 · Per-class invariants

- **`this.name` is set explicitly in every constructor.** Do NOT use `this.name = new.target.name` — minifiers mangle class names, so `new.target.name` returns `"a"` in production. The constant string survives minification.
- **Structured fields are `readonly` and typed against the slice's domain types** (`ProviderId`, `AgentId`, etc. — not raw strings). The error becomes a typed payload, not a stringly-typed bag.
- **Wrap underlying errors via `cause`**, not by string-concatenating: `super(message, { cause: originalError })`. Preserves the full stack chain for debugging without bleeding internal detail into the message.
- **No `static` factory methods** (`AdapterError.duplicate(...)`) — they hide the constructor and break `instanceof` narrowing on the call site. Call the subclass constructor directly.

---

## 3 · File layout

Errors live in an `errors/` slice following the per-slice file convention from [`code-layout.md`](./code-layout.md) §3:

```
src/adapters/errors/
  errors.ts        ← AdapterError base + subclasses
  errors.test.ts   ← instanceof checks + field-shape tests
```

**Where the `errors/` slice goes** depends on scope:

| Scope | Location |
|---|---|
| Errors thrown by code inside one provider adapter | `src/adapters/<provider>/errors.ts` (slice-local file, not a sub-slice) |
| Errors thrown across an entire layer's public surface | `src/<layer>/errors/errors.ts` (a slice of its own). Example: `src/adapters/errors/` because both `registry/` and individual `<provider>/` slices throw `AdapterError` subclasses that route handlers catch. |
| Errors thrown by the server proxy | `src/server/errors/errors.ts` once it exists |

**No central `src/errors/` god-folder.** Each layer owns its error vocabulary.

---

## 4 · When to add a new subclass

Add a new subclass the moment a `throw` site represents a **semantically distinct** failure mode — meaning a caller might want to react to it differently from existing errors in the slice.

Concrete triggers:
- A second throw site appears in the same slice with a different cause.
- A route handler needs to map an error to a specific HTTP status that other errors in the slice don't get.
- A retry policy needs to distinguish "retryable" from "fatal" — that's two subclasses, not one with a `retryable: boolean` field.

Anti-triggers (do NOT split):
- Same failure, different message wording — same subclass, vary the message.
- "Might want this granularity later" — add it when later arrives. Subclass churn is cheap; premature subclass trees rot.

---

## 5 · Tests

Each error class has a test that asserts:

- `new SubError(...) instanceof BaseError` (the catchability contract).
- `.name === "SubError"` (stable across refactors).
- Every structured field is typed and populated.

If a subclass exists without an `instanceof BaseError` test, the refactor that breaks the inheritance chain will pass CI and break production. The test costs three lines; write it.

---

## What's NOT a rule here

- "One error class per file" — preference; group related classes in `errors.ts`.
- "Always include a `cause`" — only when you're wrapping a lower-level error. Top-of-stack throws don't need one.
- "Error messages end with a period" — preference, follow what's already there.
- "Use Result/Either instead of throwing" — different paradigm. If you ever want it, that's a separate decision and rule.
