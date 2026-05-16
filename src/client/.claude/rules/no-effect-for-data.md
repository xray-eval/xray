# `useEffect` is for synchronizing with external systems — never for data

**The only legitimate `useEffect` in `src/client/` synchronizes React state with something outside React: a DOM event, a `setInterval`, a WebSocket, an `IntersectionObserver`. Data fetching, derived values, and "run this when props change" are not external systems — they have purpose-built tools that aren't `useEffect`.**

The failure mode this prevents: an LLM session has a working `useQuery` hook and then writes `useEffect(() => { if (data) setSelectedId(data[0].id); }, [data])` to "default-select the first item" — recreating the bug `useState` of derived data was supposed to avoid. A second `useState` becomes a second source of truth, the effect introduces an extra render, and a race condition shows up the day `data` arrives twice (e.g. window-focus refetch). The React team's own doc says it plainly: ["You Might Not Need an Effect"](https://react.dev/learn/you-might-not-need-an-effect).

---

## 1 · The decision tree

When you reach for `useEffect`, ask in order:

1. **Am I fetching server data?** → use `useQuery` / `useInfiniteQuery`. See [`server-state.md`](./server-state.md).
2. **Am I deriving a value from existing state or props?** → don't use state, just compute it at render: `const filtered = items.filter(...)`. No `useEffect`, no `useState`.
3. **Am I resetting state when a prop changes?** → use the `key` prop on the component, or read the prop directly. Don't `useEffect(() => setX(newProp), [newProp])`.
4. **Am I notifying a parent of a state change?** → call the parent's callback from the event handler that caused the change, not from an effect that runs *after* the change.
5. **Am I synchronizing with something outside React?** (real DOM API, real network event, real timer) → `useEffect` is the right tool.

Steps 1-4 cover 90% of the cases an LLM reaches for `useEffect`. Only step 5 is a legitimate use.

## 2 · Worked example — derived data

**Banned:**

```tsx
const [filtered, setFiltered] = useState<Session[]>([]);
useEffect(() => {
  setFiltered(items.filter((i) => i.source === "ingest"));
}, [items]);
```

**Correct:**

```tsx
const filtered = items.filter((i) => i.source === "ingest");
```

If the filter is expensive, wrap in `useMemo` — but only with a measured reason ([tkdodo.eu/blog/the-useless-use-callback](https://tkdodo.eu/blog/the-useless-use-callback) — same logic applies to `useMemo`). For a filter over a few hundred rows, plain computation is faster than the memoization overhead.

## 3 · Worked example — "reset state when prop changes"

**Banned:**

```tsx
const [cursor, setCursor] = useState<string | null>(null);
useEffect(() => { setCursor(null); }, [agentId]); // reset cursor when agentId changes
```

**Correct:**

```tsx
// Pass agentId into the queryKey; TanStack Query treats a new key as a new query.
useInfiniteQuery({ queryKey: ["sessions", { agentId }], ... });
```

Or, if it's truly client state that should reset, lift the state above and use `key={agentId}` on the consumer component. React re-mounts the component, giving you fresh state.

## 4 · Worked example — legitimate effect

Subscribing to a future SSE endpoint:

```tsx
useEffect(() => {
  const source = new EventSource(`/v1/sessions/${id}/stream`);
  source.addEventListener("turn", (e) => queryClient.setQueryData(...));
  return () => source.close();
}, [id, queryClient]);
```

External system (the browser `EventSource` API), real cleanup, real dependency. This is what `useEffect` is for.

## 5 · `useCallback` / `useMemo` — same discipline

The only two reasons to wrap a function or value in `useCallback` / `useMemo`:

1. **Referential stability for a memoized child** — e.g. `React.memo(Child)` rerenders when its prop identity changes; the parent must pass a stable function.
2. **Stabilizing a dependency array** for an effect or another hook (`useQuery`'s `queryFn` is allowed to change freely; most other hooks aren't).

Anywhere else, `useCallback` is overhead without payoff. Plain inline functions are faster than the memoization machinery for almost everything ([tkdodo.eu/blog/the-useless-use-callback](https://tkdodo.eu/blog/the-useless-use-callback)).

## 6 · Banned patterns checklist

- `useEffect(() => setState(...), [otherState])` — derived state. Compute at render.
- `useEffect(() => fetch(...).then(setState), [])` — server state. Use TanStack Query (see [`server-state.md`](./server-state.md)).
- `useEffect(() => onChange(value), [value])` — parent notification. Call `onChange` from the event handler.
- `useEffect(() => { if (cond) setX(default); }, [cond])` — initial-value pattern. Use `useState`'s initializer, or compute at render.
- `useCallback` / `useMemo` "just in case." Without a measured reason or a memoized consumer, it's dead weight.

---

## What's NOT a rule here

- "Never use `useEffect`" — false. Use it when you genuinely synchronize with an external system. The rule is the *decision tree*, not the absolute ban.
- "Always use `useMemo` for derived data" — false. Most derivations don't need memoization; profile before reaching for it.
- "Custom hooks fix everything" — extracting a bad pattern into a custom hook doesn't make it good. Apply the decision tree first; then consider whether a hook adds value.
