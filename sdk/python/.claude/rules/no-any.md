# `Any` is banned

`typing.Any` opts out of type checking. A single `Any` in a hot path
poisons every call site that touches it — `pyright --strict` infers
`Unknown` outwards, and `reportUnknown*` diagnostics light up files
that look unrelated. The rule: don't introduce `Any`. Reach for the
narrower tool instead.

## The substitutes

| You want… | Use this, not `Any` |
|---|---|
| A foreign object whose class we don't own (a LiveKit room, an OTEL span) | `Protocol` with the attrs we actually touch |
| A heterogeneous JSON body going to/from the server | `TypedDict` (per route) |
| A generic callable preserving its signature | `Callable[P, R]` with `ParamSpec` + `TypeVar` |
| "Some primitive JSON value" at a real boundary (rare) | `JsonValue` recursive alias, never bare `Any` |
| A function that statically can't know the return type (dispatch on Literal) | `assert_never(...)` after the dispatch, not `Any` |

## Banned

- `def f(x: Any) -> ...` / `-> Any` / `list[Any]` / `dict[str, Any]`.
- `cast(SomeType, value)` to launder `Any` into a real type. The cast
  is unverified — the next refactor breaks it silently.
- `getattr(obj, "name", None)` followed by a call. Either the
  attribute is in the Protocol (typed call), or it isn't (don't call).
- "`# type: ignore[no-any-return]`" and friends — `pyright --strict`
  flags unnecessary ignores via `reportUnnecessaryTypeIgnoreComment`;
  the config in `sdk/python/pyproject.toml` is the gate.

## The one tolerated edge

`object` is fine when you genuinely don't care about the value (a
token you store and pass back: `def detach(token: object) -> None`).
`object` forces every operation to be narrowed first; `Any` allows
every operation silently. Different rules.

## Why so strict

This SDK is the dev's source of truth for what a `Conversation` /
`Replay` / `AgentResponse` *is*. A consumer's IDE either tells them
the right shape or it lies. We don't ship lies.
