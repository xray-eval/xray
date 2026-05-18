# Pattern matching — `ts-pattern`, exhaustive, always

**Dispatch on a discriminated union always goes through `match(value).with(...).exhaustive()` from `ts-pattern`. Never `switch`, never `if`/`else if` chains keyed on a `.type` / `.kind` / `.tag` discriminator.**

The failure mode this prevents: someone writes a `switch (event.type)` with a `default: event satisfies never` arm. It works — exhaustiveness is checked at compile time, the tests pass. Then a fifth variant gets added to the union, two of three switch sites get updated, the third silently falls through its `default` branch in production. `satisfies never` caught one of them at the seam where the new variant was authored; it didn't catch the consumer that nobody remembered. `match(...).exhaustive()` puts the exhaustiveness *at the call site*, which is exactly where a forgotten branch hides.

Secondary motive: `ts-pattern` is already a pinned dep (`package.json`). If the codebase uses `switch` for dispatch, that dep is unused infrastructure — either delete it or actually use it. We use it.

---

## 1 · The shape

```ts
import { match } from "ts-pattern";

return match(query)
  .with({ status: "pending" }, () => <p>Loading…</p>)
  .with({ status: "error" }, (q) => <p role="alert">{q.error.message}</p>)
  .with({ status: "success" }, (q) => <List items={q.data} />)
  .exhaustive();
```

- **`.exhaustive()` is mandatory.** Never `.otherwise(() => { /* noop */ })` to silence the type error when you're "pretty sure nothing else will match" — that's the bug the rule exists to prevent. If a branch is genuinely unreachable, encode that in the union, not in the dispatcher.
- **Errors** narrow via `P.instanceOf(...)` (see [`errors.md`](./errors.md)) and end with `.exhaustive()` when the error union is closed, or `.otherwise((e) => { throw e })` when re-throwing an unknown — re-throwing is the *only* legitimate `.otherwise`.
- **Side-effect dispatchers** that return `void` still use `match(...).exhaustive()`; the return value is `void`, but the exhaustiveness check is the point.

---

## 2 · What `switch` is still allowed for

- Numeric range / fall-through logic on a primitive (`switch (statusCode)`). Not a discriminated union.
- Generated code (e.g. drizzle migrations). Don't hand-edit, don't apply this rule.

If you can't name one of those reasons, it's a discriminated union and `ts-pattern` is the answer.

---

## 3 · What's banned

- `switch (value.type)` / `switch (value.kind)` / `switch (value.tag)` — discriminated-union dispatch.
- `if (x.type === "a") ... else if (x.type === "b") ...` — same dispatch, different syntax, same problem.
- `match(...).otherwise(...)` to dodge an `.exhaustive()` failure. The fix is to add the `.with(...)` arm, not to swallow it.
- A `default:` arm whose body is `value satisfies never; return;`. The `satisfies never` is fine in isolation; the surrounding `switch` is what this rule removes.

---

## 4 · Migration

When you encounter an existing `switch` on a discriminator, convert it in the same PR you're touching the file for. Don't leave half-converted files; don't open a side-PR just to convert. The "fix in passing" rule applies because the conversion is mechanical and the diff is small.

---

## What's NOT a rule here

- "Use `ts-pattern` for everything" — no, **for discriminated-union dispatch**. A single `if (foo) bar()` is not pattern matching.
- "Always use `P.intersection` / `P.union` patterns" — preference; reach for them when they actually clarify, not as a default.
- "One `.with` per line" — formatting, follow what's already there.
