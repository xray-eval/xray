"""Replay run configuration.

The dev attaches a ``RunConfig`` per replay to record what model /
temperature / extra knobs the agent was running under. xray stores it
verbatim on the replay row and surfaces it in the compare UI so two
runs are diff-able on their config keys.

The server also hashes the config content to group every replay that ran
under the same configuration, which is what powers the cross-conversation
comparison view ("how does this strategy do over the whole suite?").
``name`` labels that group without being part of its identity.

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

    Set ``name`` to label the config group in the xray UI, so a
    comparison reads "baseline vs. gemini-flash" rather than two hash
    prefixes::

        RunConfig(name="baseline", model="gpt-4o")
    """

    model: str | None = None
    temperature: float | None = None
    #: Display label for this config's group. Purely cosmetic: the group's
    #: identity is the hash of the config *content*, which the server
    #: computes, so renaming relabels the existing group instead of forking
    #: a new one (last-write-wins, like ``Conversation.name``). Every replay
    #: with the same content lands in the same group whether it was named
    #: or not.
    name: str | None = None
    extra: dict[str, JsonValue] = field(default_factory=dict[str, JsonValue])

    def to_wire(self) -> dict[str, JsonValue]:
        """Snake_case JSON body for ``POST /v1/replays``. ``extra`` keys
        are flattened into the top-level object so the compare UI can
        diff them as first-class fields.

        ``name`` is deliberately absent: it's a label, not configuration,
        and the server hashes this object to derive the group's identity.
        Including it would make a rename fork the group. The orchestrator
        sends it alongside as ``run_config_name`` instead.

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
