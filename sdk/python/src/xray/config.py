"""Replay run configuration.

The dev attaches a ``RunConfig`` per replay to record what model /
temperature / extra knobs the agent was running under. xray stores it
verbatim on the replay row and surfaces it in the compare UI so two
runs are diff-able on their config keys.

Field-typed rather than ``dict[str, Any]`` so a typo in common keys
(``model``, ``temperature``) is a static error. Anything unusual lands
in ``extra``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from xray._json import JsonValue


@dataclass(frozen=True)
class RunConfig:
    """Per-replay run configuration. Defaults to all-None.

    >>> RunConfig(model="gpt-4o", temperature=0.5).to_wire()
    {'model': 'gpt-4o', 'temperature': 0.5}

    Use ``extra`` for provider-specific or experimental knobs::

        RunConfig(model="gpt-4o", extra={"top_p": 0.9, "strategy": "v2"})
    """

    model: str | None = None
    temperature: float | None = None
    extra: dict[str, JsonValue] = field(default_factory=dict[str, JsonValue])

    def to_wire(self) -> dict[str, JsonValue]:
        """Snake_case JSON body for ``POST /v1/replays``. ``extra`` keys
        are flattened into the top-level object so the compare UI can
        diff them as first-class fields.

        The return type is intentionally open (``dict[str, JsonValue]``):
        ``extra`` carries arbitrary developer-defined keys, so a closed
        ``TypedDict`` would lie about the shape whenever ``extra`` is
        non-empty.
        """
        body: dict[str, JsonValue] = {}
        if self.model is not None:
            body["model"] = self.model
        if self.temperature is not None:
            body["temperature"] = self.temperature
        for key, value in self.extra.items():
            body[key] = value
        return body


__all__ = ["RunConfig"]
