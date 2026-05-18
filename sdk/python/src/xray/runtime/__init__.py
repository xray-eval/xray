"""Pluggable runtime interface.

A ``Runtime`` is what actually plays the user side of a Conversation —
LiveKit, Pipecat, OpenAI Realtime, Gemini Live, raw WebSocket, anything.
v1 ships only ``xray.runtime.livekit.LiveKitRuntime``; ``Runtime`` is
defined here from day one so adding a second implementation later is
additive.
"""

from xray.runtime.base import Runtime, RuntimeResult

__all__ = ["Runtime", "RuntimeResult"]
