"""Simulated SIP-call attributes for the user-side driver.

LiveKit's SIP gateway sets a fixed vocabulary of ``sip.*`` attributes on an
inbound SIP participant: trunk + caller phone numbers, a call id, the
dispatch rule that matched, the call status. Production voice agents
typically branch on these — pick a flow by ``sip.trunkPhoneNumber``, log
by ``sip.callID``, gate on ``sip.callStatus``.

A test driver that mints its JWT with ``with_kind("sip")`` and the same
``sip.*`` attributes lands in the room as an indistinguishable SIP
participant, so the agent's existing SIP code path runs unchanged against
a scripted replay or a live mic session — no SIP-bypass branch on the
agent side.

Arbitrary additional keys — anything outside the standard ``sip.*`` set,
including custom keys promoted via a trunk's ``headers_to_attributes``
map — ride through ``extra_attrs``.

Reference: https://docs.livekit.io/sip/sip-participant. Casing matters
(``sip.callID``, not ``sip.callId``); ``to_attributes`` emits the docs
spelling verbatim.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Literal, TypeAlias

from xray.instrument import XRAY_ATTRIBUTE_KEY

# Closed picklist per the LiveKit SIP docs. Narrower than `str` so a typo at
# the call site fails pyright instead of becoming an inert attribute the
# agent never matches against.
SipCallStatus: TypeAlias = Literal["active", "automation", "dialing", "hangup", "ringing"]


@dataclass(frozen=True)
class SimulatedSipCall:
    """Every field is optional — populate only the attributes the agent
    under test reads. An empty SimulatedSipCall is rejected at construction;
    pass ``simulated_sip=None`` for a non-SIP run instead of an empty
    object.
    """

    caller_phone: str | None = None
    trunk_phone: str | None = None
    call_id: str | None = None
    call_id_full: str | None = None
    call_status: SipCallStatus | None = None
    rule_id: str | None = None
    trunk_id: str | None = None
    # Free-form passthrough for arbitrary additional keys the agent reads —
    # anything outside the standard ``sip.*`` set above. A named field wins
    # on collision so a dev can't accidentally shadow a typed attribute by
    # spelling it twice. Stored as a read-only mapping after construction
    # (see __post_init__).
    extra_attrs: Mapping[str, str] = field(default_factory=dict[str, str])

    def __post_init__(self) -> None:
        if XRAY_ATTRIBUTE_KEY in self.extra_attrs:
            raise ValueError(
                f"SimulatedSipCall.extra_attrs must not contain the reserved "
                f"{XRAY_ATTRIBUTE_KEY!r} key — it carries the replay binding the "
                f"agent reads to attribute its spans. Use the sip.* fields for SIP "
                f"attributes; never override the xray binding."
            )
        if not self._has_any():
            raise ValueError(
                "SimulatedSipCall requires at least one attribute. "
                "Pass simulated_sip=None for a non-SIP run."
            )
        # frozen=True blocks field reassignment but not mutation of a dict
        # field — a post-construction extra_attrs["xray"]=... would slip the
        # reserved-key guard above and clobber the binding at mint time. Freeze
        # a copy so the guard can't be bypassed after construction.
        object.__setattr__(self, "extra_attrs", MappingProxyType(dict(self.extra_attrs)))

    def _has_any(self) -> bool:
        return (
            any(
                v is not None
                for v in (
                    self.caller_phone,
                    self.trunk_phone,
                    self.call_id,
                    self.call_id_full,
                    self.call_status,
                    self.rule_id,
                    self.trunk_id,
                )
            )
            or len(self.extra_attrs) > 0
        )

    def to_attributes(self) -> dict[str, str]:
        attrs: dict[str, str] = {}
        if self.caller_phone is not None:
            attrs["sip.phoneNumber"] = self.caller_phone
        if self.trunk_phone is not None:
            attrs["sip.trunkPhoneNumber"] = self.trunk_phone
        if self.call_id is not None:
            attrs["sip.callID"] = self.call_id
        if self.call_id_full is not None:
            attrs["sip.callIDFull"] = self.call_id_full
        if self.call_status is not None:
            attrs["sip.callStatus"] = self.call_status
        if self.rule_id is not None:
            attrs["sip.ruleID"] = self.rule_id
        if self.trunk_id is not None:
            attrs["sip.trunkID"] = self.trunk_id
        for k, v in self.extra_attrs.items():
            attrs.setdefault(k, v)
        return attrs


__all__ = ["SimulatedSipCall", "SipCallStatus"]
