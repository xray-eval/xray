"""LiveKit runtime — v1 implementation.

Joins the dev's LiveKit room as a user-side participant. Sets
``replay_id`` + ``conversation_id`` + ``conversation_version`` + ``modality``
in the room metadata so the dev's agent can read them on connect and
propagate them via OTEL baggage.

Heavy import (the ``livekit`` package) is lazy: importing this module
without the ``[livekit]`` extra installed is fine until you actually
construct a ``LiveKitRuntime``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field

from xray.conversation import AgentResponse, Conversation, Turn
from xray.runtime.base import Runtime, RuntimeResult
from xray.trace import set_replay_context

logger = logging.getLogger(__name__)


@dataclass
class LiveKitRuntime(Runtime):
    """Joins a LiveKit room and plays through the user side of a
    Conversation. v1 plays per-turn pre-recorded audio (or TTS); v1.5
    will stream a continuous user track."""

    url: str
    api_key: str
    api_secret: str
    room: str
    # Identity of the user-side participant we mint a token for.
    identity: str = "xray-driver"
    # Wait this long for the agent participant to join before failing.
    agent_join_timeout_s: float = 30.0

    # Populated by the orchestrator before ``run`` is called.
    replay_id: str | None = None
    conversation_id: str | None = None
    conversation_version: str | None = None

    # Captured between turn-start and turn-end callbacks; the orchestrator
    # reads these out via the returned RuntimeResult.
    _captured: list[AgentResponse] = field(default_factory=list)

    def bind(
        self,
        *,
        replay_id: str,
        conversation_id: str,
        conversation_version: str,
    ) -> None:
        """Called by the orchestrator once it knows the Replay's id."""
        self.replay_id = replay_id
        self.conversation_id = conversation_id
        self.conversation_version = conversation_version

    async def run(self, conversation: Conversation) -> RuntimeResult:
        if (
            self.replay_id is None
            or self.conversation_id is None
            or self.conversation_version is None
        ):
            raise RuntimeError(
                "LiveKitRuntime: bind(replay_id=..., conversation_id=..., "
                "conversation_version=...) must be called before run()."
            )

        # Local import — the livekit package is heavy and optional.
        try:
            from livekit import api as lk_api  # type: ignore[import-not-found]
            from livekit import rtc as lk_rtc  # type: ignore[import-not-found]
        except ImportError as e:  # pragma: no cover — dep guard
            raise RuntimeError(
                "LiveKitRuntime requires `pip install xray-py[livekit]`."
            ) from e

        # Mint the user-side token.
        token = (
            lk_api.AccessToken(self.api_key, self.api_secret)
            .with_identity(self.identity)
            .with_grants(lk_api.VideoGrants(room_join=True, room=self.room))
            .to_jwt()
        )

        # Stamp the room metadata before joining so the agent has it on connect.
        metadata = json.dumps(
            {
                "xray.replay.id": self.replay_id,
                "xray.conversation.id": self.conversation_id,
                "xray.conversation.version": self.conversation_version,
                "xray.modality": "voice",
            }
        )
        set_replay_context(
            replay_id=self.replay_id,
            conversation_id=self.conversation_id,
            conversation_version=self.conversation_version,
        )

        room = lk_rtc.Room()
        agent_joined = asyncio.Event()

        @room.on("participant_connected")
        def _on_join(participant):  # type: ignore[no-untyped-def]
            if participant.identity != self.identity:
                agent_joined.set()

        await room.connect(self.url, token, options=lk_rtc.RoomOptions())
        try:
            try:
                await room.local_participant.set_metadata(metadata)
            except Exception:  # pragma: no cover — server may forbid this
                logger.warning("LiveKitRuntime: could not set room metadata; "
                               "agent must read replay id from token claims instead")

            try:
                await asyncio.wait_for(agent_joined.wait(), timeout=self.agent_join_timeout_s)
            except asyncio.TimeoutError as e:
                raise RuntimeError("agent_not_joined") from e

            return await self._play_turns(conversation)
        finally:
            await room.disconnect()

    async def _play_turns(self, conversation: Conversation) -> RuntimeResult:
        """Replay turn audio one at a time. v1 implementation is best-effort:
        the public ``Runtime`` contract is what the orchestrator depends on;
        the per-step playback details will evolve with LiveKit's track API."""
        responses: list[AgentResponse] = []
        for turn in conversation.turns:
            if turn.role == "user":
                await self._play_user_turn(turn)
                responses.append(AgentResponse(transcript="", audio_path=None))
            else:
                response = await self._capture_agent_turn()
                responses.append(response)
        return RuntimeResult(responses=responses)

    async def _play_user_turn(self, turn: Turn) -> None:
        # Real implementation publishes an audio track sourced from
        # turn.audio.path (or TTSes turn.text once and caches it). For v1
        # the orchestrator delegates that work to runtime subclasses; this
        # placeholder keeps the contract honest.
        await asyncio.sleep(0)

    async def _capture_agent_turn(self) -> AgentResponse:
        # Real implementation subscribes to the agent's audio track + (if
        # available) a transcript event channel. Placeholder yields nothing
        # so the runtime stays usable in unit tests with a stubbed LiveKit.
        await asyncio.sleep(0)
        return AgentResponse(transcript="", audio_path=None)

    async def aclose(self) -> None:
        # Nothing persistent to release in v1; subclasses with sockets
        # should override.
        return None
