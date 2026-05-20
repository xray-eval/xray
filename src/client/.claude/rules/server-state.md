# Server state lives in TanStack Query, never in `useState`

**Any data the SPA fetches from `/v1/...` is server state. Server state is read through `useQuery` / `useInfiniteQuery` from `@tanstack/react-query`. Never reach for `useState + useEffect + fetch` to render data that the server owns.**

The failure mode this prevents: an LLM session sees a list of sessions in the UI and reaches for the React 101 pattern — `const [data, setData] = useState([]); const [loading, setLoading] = useState(true); useEffect(() => fetch(...).then(setData), [])`. That snippet has six latent bugs (race condition on re-fetch, no caching, no deduplication, no abort, no background revalidation, no shared cache across components) and it ships looking fine because the happy path renders. The previous version of `ConversationsList` was exactly that pattern, ~180 LOC of hand-rolled state machine. The TanStack Query rewrite is ~110 LOC and fixes all six issues for free.

**Why this is a hard rule, not a preference.** The boundary between "server state" and "client state" is the single most useful distinction in modern React frontend ([tkdodo.eu/blog/react-query-as-a-state-manager](https://tkdodo.eu/blog/react-query-as-a-state-manager)). Server state has properties client state doesn't — it's remote, asynchronous, owned by another system, and can change without the client knowing. Treating them the same forces the component to re-invent caching, staleness, and request deduplication every time. The React team themselves now recommend a data-fetching library over inline Effects ([react.dev/learn/you-might-not-need-an-effect](https://react.dev/learn/you-might-not-need-an-effect)).

---

## 1 · What goes through TanStack Query

- Every read from `/v1/...` on the xray API.
- Future reads from any third-party API the client talks to directly.
- WebSocket-driven server state (push it through `queryClient.setQueryData`).

## 2 · What stays in `useState`

- UI toggles: open/closed, expanded/collapsed, selected tab.
- Form input values *while the user types* (a hook like RHF replaces this once forms appear; not in scope today).
- Anything that doesn't survive a page refresh and isn't worth caching.

## 3 · The shape

Wrap the app once at the top:

```tsx
// src/client/app.tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { createQueryClient } from "./api/query-client.ts";

export function App() {
  const [queryClient] = useState(createQueryClient);
  return <QueryClientProvider client={queryClient}>{...}</QueryClientProvider>;
}
```

Then any component reads server data with a single hook:

```tsx
// src/client/conversations/conversations.tsx
const query = useInfiniteQuery<...>({
  queryKey: ["sessions", { agentId }],
  queryFn: ({ pageParam, signal }) => fetchSessions({ ... }),
  initialPageParam: undefined,
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
});
```

Pure fetch logic (URL construction, schema validation, error mapping) lives in `src/client/api/*-api.ts`. Hooks call it; tests call it.

## 4 · `queryKey` discipline

- **Always an array**, even for keyless queries (`["sessions"]`).
- **Filter args are nested objects**, not flat string concatenation: `["sessions", { agentId }]`, not `["sessions", agentId]`. This makes partial invalidation (`queryClient.invalidateQueries({ queryKey: ["sessions"] })`) work the way the docs describe ([tkdodo.eu/blog/effective-react-query-keys](https://tkdodo.eu/blog/effective-react-query-keys)).
- **The first element is a stable string namespace** matching the slice (`"sessions"`, `"agents"`, `"replays"`).

## 5 · The defaults

`createQueryClient` in `src/client/api/query-client.ts` sets:

- `staleTime: 30_000` — refetch the same key at most every 30s. xray is single-user; aggressive revalidation isn't useful.
- `retry: false` — a failing endpoint should surface, not mask itself behind three silent retries.
- `refetchOnWindowFocus: false` — debugger tool, not a live dashboard.

Don't override these on individual queries without a written reason. Per-call overrides are a smell that the defaults are wrong.

## 6 · Conditional fetches — use `skipToken`, not a fake `queryFn`

When `queryFn` depends on a value that may be `undefined` (e.g. an id derived from a previous query), reach for TanStack Query's `skipToken` — never write a `Promise.reject(...)` branch behind an `enabled` flag. The rejected branch is unreachable at runtime (it's guarded by `enabled: false`), but it lies in the type and clutters the call site.

**Banned:**

```tsx
const conversation = useQuery({
  queryKey: ["conversations", { id: conversationId ?? "" }], // phantom "" slot
  queryFn: ({ signal }) =>
    conversationId !== undefined
      ? getConversation(conversationId, { signal })
      : Promise.reject(new Error("no conversation id")),  // dead code
  enabled: conversationId !== undefined,
});
```

**Correct:**

```tsx
import { skipToken, useQuery } from "@tanstack/react-query";

const conversation = useQuery({
  queryKey: ["conversations", { id: conversationId }],     // undefined is fine
  queryFn:
    conversationId === undefined
      ? skipToken
      : ({ signal }) => getConversation(conversationId, { signal }),
});
```

`skipToken` is a sentinel value TanStack Query treats identically to `enabled: false` at runtime, but the type checker narrows `conversationId` to a defined value inside the function branch — so no dead-code reject, no `?? ""` fallback in the queryKey. One construct, zero unreachable code.

## 7 · Tests

- Wrap rendered components in `withQueryClient(...)` from `src/client/test-utils.tsx`. Each call constructs a fresh `QueryClient` so cache state doesn't leak between tests.
- The test-time `QueryClient` overrides `retry: false` and `staleTime: 0` — make tests deterministic and force a real refetch on every render.
- MSW intercepts `fetchSessions`'s underlying `fetch`; never mock the React Query hook itself.

## 8 · Banned

- `useEffect(() => fetch(...).then(setState), [...])` anywhere in `src/client/`. Convert to a `useQuery` in the same edit.
- `useState` of fetched data. If you find yourself writing `const [items, setItems] = useState<Foo[]>([])` followed by an effect, you have server state — promote it to a query.
- Talking to `/v1/...` from outside `src/client/api/*`. Components call the typed API helper; they don't reach for `fetch` directly.
- `fetch(...)` without `signal`. Always thread the `signal` from `queryFn` through so cancellation works on unmount and refetch.

---

## What's NOT a rule here

- "Always use TanStack Query, even for static config" — no, **for server state**. Reading a JSON file shipped with the bundle isn't server state.
- "Always mutate via `useMutation`" — covered in a future rule when xray ships mutating endpoints. List is read-only today.
- Specific `staleTime` values per query — the defaults are tuned for the current workload; if a future endpoint has different staleness semantics, document it where the query lives.
