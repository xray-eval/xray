# Component shape — small, composable, one concern per component

**A React component does one thing. If it takes more than ~4 behavioral props or its JSX body grows past ~80 lines, split. Prefer compound components that share state through context over a "god component" with 15 boolean toggles.**

The failure mode this prevents: an LLM session adds "another mode" to an existing component by tacking on `showFooter`, `compact`, `interactive`, `withBorder`, `variant="dense"` — five new boolean props. The component's signature now says nothing about what it *does*; you have to read the body to find out. Worse, each prop's branches multiply: 2^5 = 32 visual permutations the author has now committed to, three of which were tested. Kent C. Dodds' "Compound Components" pattern ([kentcdodds.com/blog/compound-components-with-react-hooks](https://kentcdodds.com/blog/compound-components-with-react-hooks)) is the canonical alternative: instead of `<Inspector showHeader compact />`, write `<Inspector><Inspector.Header /></Inspector>` and let the caller compose.

---

## 1 · The size signals

The triggers, in priority order:

1. **Behavioral prop count.** More than ~4 props that change *what the component does* (not just *what it shows*) is a signal to split. "Behavioral" excludes `className`, `id`, `aria-*`, `data-*`, `children`.
2. **JSX body.** Past ~80 lines of return-statement JSX, the component is doing two layout concerns. Split the inner concern into a sub-component.
3. **`if`/`?:` count inside JSX.** More than ~3 conditional branches at the same depth inside the return is the same smell as a long if/else cascade — usually one variant wants its own component.

Like every "lines of code" heuristic, these are *signals*, not laws. A 100-line JSX block of one cohesive layout is fine. A 30-line component doing two responsibilities should still split.

## 2 · The split moves

- **Extract a sub-component for the inner concern.** `<ConversationsList>` renders `<ConversationRow>` per item and `<EmptyState>` for the empty case. Each one is small and one-concern. Sub-components live in the *same file* as their parent until they grow enough to warrant their own slice file ([code-layout.md §5](../../../../.claude/rules/code-layout.md)).
- **Compound components** when behavior is shared across slots. The classic shape:

  ```tsx
  <Inspector sessionId={id}>
    <Inspector.Header />
    <Inspector.Transcript />
    <Inspector.ToolCallSidebar />
  </Inspector>
  ```

  `Inspector` provides context; each child reads it. Each child is a separate component that does ONE thing. The caller composes the layout it wants. Boolean props go away.

- **Render props / children-as-function** are usually outclassed by hooks now. Reach for a hook before a render prop.

## 3 · Banned

- A component with 5+ boolean props. Split — even if the body is short.
- "God component" props like `mode: "edit" | "view" | "preview" | "compact" | "dense"`. Each mode is its own component.
- "Smart vs. dumb" split as an a-priori design ([Dan Abramov retracted that pattern in 2019](https://medium.com/@dan_abramov/smart-and-dumb-components-7ca2f9a7c7d0)). With TanStack Query, any component can `useQuery` without being "impure." Co-locate the query with the component that needs the data.
- A barrel `index.tsx` re-exporting slot components. Match the root [`code-layout.md §4`](../../../../.claude/rules/code-layout.md): each sub-component lives in a real file with a real name, imported directly.

## 4 · Co-locating sub-components

Inside one slice file:

```tsx
// src/client/conversations/conversations.tsx
export function ConversationsList({ ... }) { ... }

function ConversationRow({ session }: { session: SessionListItem }) { ... }
function EmptyState() { ... }
```

Sub-components are NOT exported until a second consumer appears outside the file. The trigger to give them their own file is when they grow enough to deserve their own test (`code-layout.md §5`).

---

## What's NOT a rule here

- "Components must be under 50 lines" — the cap is `~80 lines of JSX body`, and it's a signal, not a law.
- "Always extract sub-components, even tiny ones" — false. A `<span>{label}</span>` inline is fine. Extract when there's a name worth giving the sub-component, not "just because."
- "Always use compound components" — they're the right answer when behavior is shared across slots. For unrelated children, plain `children` is fine.
- "Container/Presentational" — explicitly out, see above.
