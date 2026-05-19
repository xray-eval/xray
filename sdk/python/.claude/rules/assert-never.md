# Exhaustive dispatch ends with `assert_never`

Every dispatch on a `Literal` or a discriminated union ends with
`typing.assert_never(value)`. The call is unreachable at runtime
(pyright proves it); it exists so that adding a new variant to the
union turns the dispatch into a static error at every call site that
forgot to handle it.

The failure mode this prevents: someone adds `"timed_out"` to
`FailureReason`, the type alias compiles, runtime tests still pass on
the existing branches, the orchestrator's status branch silently falls
through to the `else` and writes the wrong status to the server.

## The shape

```python
from typing import assert_never

def render(status: AssertionStatus) -> str:
    match status:
        case "passed":
            return "OK"
        case "failed":
            return "FAIL"
        case "errored":
            return "ERR"
        case _:
            assert_never(status)  # static error if a variant is added
```

Equivalent `if`/`elif` chain ends the same way:

```python
if status == "passed": ...
elif status == "failed": ...
elif status == "errored": ...
else:
    assert_never(status)
```

## Banned

- A `match` on a Literal without `assert_never` in the wildcard arm.
- `match` on a discriminated dataclass union without `assert_never` in
  the wildcard arm.
- `else: raise ValueError(...)` as the catch-all — that's "unreachable
  at runtime" too, but it doesn't statically prove exhaustiveness, so
  the new-variant case at the top still silently compiles.
- `else: pass` / `else: return None` — fall-throughs are bugs.

## Where this applies in this SDK

- `Role` (`"user" | "agent"`) → branches in `runtime/livekit.py`.
- `AudioRef` discriminated union → branches in
  `_load_or_synth_user_pcm`.
- `AssertionOutcome.status` / `JudgeOutcome.status` → any place we
  render or transmit them.
- `FailureReason` → orchestrator status path.
