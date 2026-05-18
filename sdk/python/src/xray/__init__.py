"""xray-py — Python SDK for xray.

Public surface:

- ``xray.conversation`` — test-definition primitives (``Conversation``, ``Turn``,
  ``expect_agent_turn``).
- ``xray.trace`` — OpenTelemetry decorators that propagate ``xray.replay.id`` via
  baggage.
- ``xray.runtime`` — pluggable runtime ABC.
- ``xray.runtime.livekit`` — v1 LiveKit implementation.
- ``xray.run`` — convenience orchestrator: create the Conversation + Replay, run
  the runtime, evaluate assertions/judge, PATCH the Replay row.
"""

from xray.conversation import (
    Conversation,
    Turn,
    expect_agent_turn,
)
from xray.orchestrator import RunResult, run

__all__ = [
    "Conversation",
    "RunResult",
    "Turn",
    "expect_agent_turn",
    "run",
]

__version__ = "0.0.1"
