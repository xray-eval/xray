# Comments — explain *why*, never *what*

**Default to writing no comments.** A comment earns its place only when removing it would leave a future reader missing context they can't get from the code itself: a hidden constraint, a non-obvious tradeoff, a workaround for a specific bug, a warning about subtle behavior. Anything else is noise that rots.

The failure mode this prevents has three recurring shapes — each one is the kind of comment an LLM produces by default unless explicitly told not to:

1. **States the obvious.** `// increment counter` above `counter++`. `// loop through items` above a `for`. The code already says what's happening; the comment adds a line of visual noise and zero information.
2. **Describes intent instead of behavior, then rots.** `// validates the user's session and returns 401 if expired` above a function that no longer touches sessions because someone refactored two months ago. The comment is now a lie the next reader trusts.
3. **Conversational artifact.** `// Now let's add error handling here.` `// Updated to fix the bug.` `// TODO: removed the old try/catch for now.` These belong in the PR description, the commit message, or a Slack thread. They are the sediment of how the code was written, not what it does.

The training pressure on LLMs leans toward over-commenting (the model is rewarded for "explaining its reasoning" in chat — that habit bleeds into source files). This rule is the explicit override: **a missing comment is recoverable; a misleading or noisy one isn't.**

---

## 1 · When a comment earns its place

| Comment kind | Keep? | Example |
|---|---|---|
| **Why this code exists** — a constraint, deadline, incident, or external requirement that the code itself can't express | ✅ | `// MIN-merge keeps startedAt <= min(turn.ts) so a late session_started can't push the stub forward past an already-recorded turn` |
| **Non-obvious tradeoff** — naming the alternative and why it lost | ✅ | `// Set explicitly per class — new.target.name would be mangled by minifiers` |
| **Workaround for a known bug** — link the upstream issue / quirk | ✅ | `// Bun's HTML bundler doesn't follow query-string imports; inline the SVG instead. https://github.com/oven-sh/bun/issues/N` |
| **Warning about subtle behavior** — invariant, ordering requirement, undocumented side-effect | ✅ | `// FK enforcement is off by default in SQLite. Required for ON DELETE CASCADE.` |
| **Public-API documentation** — JSDoc on exported functions/types describing contract, parameters, and error shape | ✅ | `/** Throws StoreParentDirNotFoundError if the parent directory of opts.path does not exist. */` |
| **Sentinel for codegen / structured tooling** — `@ts-expect-error`, `eslint-disable-next-line`, `biome-ignore`, codegen guard | ✅ | `// biome-ignore lint/style/noNonNullAssertion: validated by Valibot on line 42` |
| Describes what a line of code does | ❌ | `// increment counter` above `counter++` |
| Describes intent without explaining why | ❌ | `// validate the input` above a single call to a function literally named `validate` |
| Past tense or first-person narrative | ❌ | `// I changed this to use Map`, `// Now using Date.toISOString()` |
| Marker / decoration | ❌ | `// ===== HELPERS =====`, `// --- Type definitions ---` |
| Commented-out code "in case we need it" | ❌ | `// const oldImpl = ...` |
| `TODO` / `FIXME` / `XXX` without an owner and a link to a tracking issue | ❌ | `// TODO: handle the other case` |

---

## 2 · Test the comment before you write it

**Default to delete.** A comment earns its place only if all three checks pass; if any one fails, drop it.

1. **Does the comment say something the code doesn't already say?** If a competent reader can derive the comment's content from the line below it, the comment is noise. A precisely-named function, a typed signature, an explicit error message, or a self-evident variable all count as "the code already says this." (`// returns the user's id` above `return user.id;` — already obvious.)
2. **Will the comment still be true after a refactor that changes the line below it?** If the comment hard-codes a *what* (a return value, a status code, a method name), it rots the moment that line changes. If the comment encodes a *why* (the constraint that forced this line to exist), it survives — because the constraint outlives the implementation.
3. **If I deleted this comment, would a future reader make a *concrete wrong decision* — not just be mildly less informed?** A wrong decision means: introducing a bug, undoing a safety mechanism, picking a worse alternative they would have ruled out with the comment, "fixing" something that wasn't broken. Mild loss of context is not enough. Vague benefit ("helps the next dev") is the trap; demand a specific failure the comment prevents.

If you find yourself writing "this prevents a future agent from getting it wrong" without being able to name the concrete bad fix, you're rationalizing. **Delete.** The training pressure pushes toward keeping comments; you have to push back.

---

## 3 · JSDoc on exported APIs

Different bar. A `/** ... */` block on an exported function, type, or class is **contract documentation**, not running commentary. Keep it when it:

- Describes what the function returns when called correctly (especially when the type is broad — e.g. `unknown`, `Promise<void>`, a discriminated union).
- Names the exceptions/typed errors it can throw.
- Documents an invariant the caller must respect (preconditions, idempotency, ordering).

Drop it when it just restates the signature in English: `/** Gets the user. @param id The user's id. @returns The user. */` above `function getUser(id: string): User`. The signature is the documentation.

---

## 4 · Migration policy

When you're editing a file and pass a noise comment, delete it in the same edit — same "fix in passing" reflex as in [`pattern-matching.md`](./pattern-matching.md) §4. Don't open a side-PR for a comment-only sweep unless the cleanup is the explicit task. Don't refactor comments you're not already touching the surrounding code for.

For the inverse — a missing *why* comment for code you're authoring — write it now, while the reasoning is in your head. Three months later it won't be, and the next reader gets nothing.

---

## What's NOT a rule here

- **"No comments ever."** False. The rule is "no comments by default" + "comments earn their place when the *why* is non-obvious".
- **"Comments must end with a period."** Formatting preference; follow what's already in the file.
- **"Use `//` not `/* */`."** Preference. Single-line `//` is conventional in this repo; multi-line JSDoc uses `/** */`. Match neighbors.
- **"Every public export gets a JSDoc."** No — *complex* public exports do. A function with a self-evident two-word name and a precise signature doesn't need a doc block.
- **Translations / non-English comments.** Out of scope; only English comments exist here.
