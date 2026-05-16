# Render state is a discriminated union, dispatched with `ts-pattern`

**Any component that renders different markup for loading / error / success / empty / "loading more" represents that state as a discriminated union and dispatches over it with `match(state).with(...).exhaustive()`. Never use parallel boolean flags (`isLoading`, `isError`, `data`) that can contradict each other.**

The failure mode this prevents: a component starts with `isLoading: boolean` + `data: Foo | null`, and a future variant adds `isRefreshing` or `isError`. The render branches become `if (isLoading) ... else if (isError) ... else if (data) ... else ...` — and "loading=true AND data=non-null" is a representable state that's *supposed* to mean "refreshing in the background" but actually means whatever the author wrote that day. A discriminated union makes the impossible combinations unrepresentable at the type level ([developerway.com/posts/advanced-typescript-for-react-developers-discriminated-unions](https://www.developerway.com/posts/advanced-typescript-for-react-developers-discriminated-unions)). Combined with `match(...).exhaustive()` from the already-pinned `ts-pattern` dep, every new variant forces a compile error at every render site that doesn't handle it. This is the same rule as the root [`.claude/rules/pattern-matching.md`](../../../../.claude/rules/pattern-matching.md), applied at the render layer.

---

## 1 · The shape

```tsx
return match(query)
  .with({ status: "pending" }, () => <p>Loading…</p>)
  .with({ status: "error" }, (q) => <p role="alert">{q.error.message}</p>)
  .with({ status: "success" }, (q) => <List items={q.data} />)
  .exhaustive();
```

`useQuery` and `useInfiniteQuery` from TanStack Query already return this shape via the `status` discriminator (`"pending" | "error" | "success"`). The component's job is to dispatch on it with `match(...).exhaustive()` — that's it.

## 2 · When the shape isn't free

For hand-rolled async (rare — see [`server-state.md`](./server-state.md), 99% of cases should be TanStack Query), define your own union:

```ts
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: SessionListItem[] };
```

The discriminator field is `kind` (or `status`, or `state` — pick one per file). It is always a string literal union. `boolean` discriminators are banned.

## 3 · Banned

- `isLoading: boolean` + `data: T | null` + `error: Error | null` as **the component's own state shape**. (Reading them OFF a library type like TanStack Query's return value is fine — but you dispatch on `status`, not the booleans.)
- `if (isLoading) ... else if (isError) ... else ...` chains. Same root cause as the root pattern-matching rule.
- `state ?? defaultState` to "default" an unset variant. The union should include the unset state as an explicit variant (`{ kind: "loading" }`), not encode it as `null`.
- A `default:` branch in a switch on the discriminator. If `.exhaustive()` isn't an option (third-party library types), use ts-pattern's `match` anyway and rely on `.exhaustive()` failing the build when a variant is missed.

## 4 · `aria-busy` and friends derive from the union

The render-state union is also the source of truth for accessibility signals:

```tsx
<aside aria-busy={query.isPending}>...</aside>
```

When a new "loading more" variant gets added, this expression updates in one place. With parallel booleans you'd have to chase down every `aria-*` site.

---

## What's NOT a rule here

- "Always name the discriminator `status`" — preference; pick one per file. Match what the surrounding library uses.
- "Always render a spinner for `pending`" — preference; depends on UX.
- Render-as-you-fetch / Suspense — separate paradigm. If we adopt Suspense for `useSuspenseQuery` later, this rule still applies: the discriminator just changes from runtime to the throw/render boundary, and `match` becomes unnecessary because Suspense + ErrorBoundary handle two of the variants structurally.
