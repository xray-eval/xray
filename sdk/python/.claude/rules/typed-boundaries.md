# `TypedDict` for every wire payload

The SDK speaks to two trust boundaries: the xray HTTP API (server) and
the dev's runtime code (subclass of ``Runtime``). At both boundaries,
shapes are declared, never inferred.

## 1 · Outbound JSON is `TypedDict`, never `dict[str, Any]`

Every body the SDK sends (`POST /v1/conversations`,
`POST /v1/replays`, `PATCH /v1/replays/:id`, `POST /v1/replays/:id/audio`)
is a ``TypedDict`` matching the server's Valibot schema:

```python
from typing import Literal, NotRequired, TypedDict

class ReplayCreateBody(TypedDict):
    conversationId: str
    conversationVersion: str
    modality: Literal["voice"]
    runConfig: NotRequired[JsonObject]
```

- Field names match the server (`camelCase`). The SDK speaks the
  server's wire shape; we do not translate at this layer.
- Optional fields use ``NotRequired[...]``, not ``Required`` with a
  ``None`` value.
- ``runConfig`` is the *one* place ``JsonObject`` (= ``dict[str,
  JsonValue]``) is allowed — it's an opaque pass-through the dev
  owns. Use ``xray._json.JsonObject``, never ``dict[str, Any]``.

## 2 · Inbound JSON is `TypedDict` + an `isinstance` narrow

Server responses are read as ``TypedDict`` and narrowed at the call
site. ``httpx``'s ``response.json()`` returns ``Any``; the SDK launders
that into ``object`` and walks it:

```python
class ReplayCreateResponse(TypedDict):
    id: str
    status: Literal["running", "completed", "failed"]

raw: object = response.json()
if not isinstance(raw, dict) or "id" not in raw:
    raise XrayError("malformed /v1/replays response")
# raw is now narrowed enough that the field access below is safe;
# the TypedDict cast happens at the assignment to a typed local.
```

(Yes, this is annoying. Yes, it's correct. The alternative is trusting
the server to never mis-shape a response, and that's exactly the
trust we don't extend at a boundary.)

## 3 · Branded IDs are not the default

``NewType`` branding for IDs (``ReplayId = NewType("ReplayId", str)``)
is a tool, not a rule. Reach for it only at a function boundary
that takes two same-shaped IDs *positionally*. Most cross-boundary
calls in this SDK pass IDs as kwargs — the keyword name already
disambiguates and ``NewType`` would just add ceremony.
