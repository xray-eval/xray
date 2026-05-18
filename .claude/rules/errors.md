# Errors are typed classes, not strings

**Every `throw` in `src/` throws an `Error` subclass, never a raw `new Error("...")`.** The thing being thrown carries a static type, a stable `.name`, and any structured data the caller might need. Callers discriminate via `instanceof` (which narrows the type — no `as` cast needed, see [`code-layout.md`](./code-layout.md) and the banned-`as`-cast plugin).

The failure mode this prevents: someone writes `throw new Error("Adapter for provider \"elevenlabs\" is already registered")`, a route handler later wants to map it to a 409, the only way to detect it is `String(e.message).includes("already registered")`. The message is now load-bearing — renaming it breaks the handler silently. Worse, two unrelated errors that happen to share a substring collide.

---

## 1 · Shape

Every error slice has:

- One **base class** named after the slice's domain (`ConversationError`, `ReplayError`, `OtlpError`). Extends `Error`. Sets `this.name` in the constructor.
- One **subclass per semantically distinct failure** (`VersionFingerprintMismatchError`, `ReplayNotFoundError`, `TooManySpansForReplayError`). Each extends the base. Each sets its own `this.name` and exposes any structured data as `readonly` fields.

Canonical shape (see `src/server/conversations/conversations.errors.ts`):

```ts
export class ConversationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationError";
  }
}

export class VersionFingerprintMismatchError extends ConversationError {
  readonly conversationId: string;
  readonly conversationVersion: string;
  constructor(conversationId: string, conversationVersion: string) {
    super(
      `Conversation "${conversationId}" version "${conversationVersion}" already exists with a different turn structure`,
    );
    this.name = "VersionFingerprintMismatchError";
    this.conversationId = conversationId;
    this.conversationVersion = conversationVersion;
  }
}
```

Callers narrow without casting:

```ts
try { upsertConversation(...) }
catch (e) {
  if (e instanceof VersionFingerprintMismatchError) {
    // e.conversationId / e.conversationVersion are typed here — no cast
    return Response.json({ error: "version_fingerprint_mismatch", ... }, { status: 409 });
  }
  if (e instanceof ConversationError) { /* generic conversation-layer failure */ }
  throw e;
}
```

Pairs cleanly with `ts-pattern`:

```ts
match(e)
  .with(P.instanceOf(VersionFingerprintMismatchError), (err) => ...)
  .with(P.instanceOf(ConversationError), (err) => ...)
  .otherwise(() => { throw e });
```

---

## 2 · Per-class invariants

- **`this.name` is set explicitly in every constructor.** Do NOT use `this.name = new.target.name` — minifiers mangle class names, so `new.target.name` returns `"a"` in production. The constant string survives minification.
- **Structured fields are `readonly` and typed against the slice's domain types** (a branded `ReplayId`, a `ConversationVersion` string alias, etc. — not raw `string`). The error becomes a typed payload, not a stringly-typed bag.
- **Wrap underlying errors via `cause`**, not by string-concatenating: `super(message, { cause: originalError })`. Preserves the full stack chain for debugging without bleeding internal detail into the message.
- **No `static` factory methods** (`ConversationError.versionMismatch(...)`) — they hide the constructor and break `instanceof` narrowing on the call site. Call the subclass constructor directly.

---

## 3 · File layout

Errors live in `<slice>.errors.ts` next to the slice they belong to, following the role-suffixed file convention from [`code-layout.md`](./code-layout.md) §3:

```
src/server/replays/
  replays.errors.ts        ← ReplayError base + subclasses
  replays.errors.test.ts   ← instanceof checks + field-shape tests
```

**Where the errors file goes** depends on scope:

| Scope | Location |
|---|---|
| Errors thrown by one slice (router + service) | `src/<layer>/<slice>/<slice>.errors.ts` (file co-located with the slice) |
| Errors thrown across many sub-slices of one feature | `src/<layer>/<feature>/errors/errors.ts` (a slice of its own) when there are genuinely multiple consumers; otherwise stay co-located |

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
