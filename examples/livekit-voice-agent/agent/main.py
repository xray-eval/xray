"""Minimal LiveKit Agents worker — Gemini Live (v2v) wired to xray."""

from __future__ import annotations

import asyncio
import logging
import os
import time

import xray
from google.genai import types as genai_types
from langfuse import observe
from livekit import rtc
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.agents.llm import ChatMessage
from livekit.agents.voice.events import ConversationItemAddedEvent
from livekit.plugins import google
from opentelemetry import trace

logger = logging.getLogger("voice-agent")
_tracer = trace.get_tracer("example-voice-agent")


@observe(as_type="generation", name="example_langfuse_step")
def _langfuse_step(model: str) -> str:
    return f"agent will use {model}"


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    async with xray.attach(ctx, service_name="example-voice-agent") as xray_session:
        session = AgentSession(
            llm=google.realtime.RealtimeModel(
                model=os.environ.get("GEMINI_MODEL", "gemini-2.5-flash-native-audio-preview-12-2025"),
                voice="Puck",
                output_audio_transcription=genai_types.AudioTranscriptionConfig(),
                input_audio_transcription=genai_types.AudioTranscriptionConfig(),
            ),
        )

        # RoomIO's default transcript forwarder races with Gemini Live's first
        # frame; republishing on `conversation_item_added` is the reliable path.
        @session.on("conversation_item_added")
        def _on_item(event: ConversationItemAddedEvent) -> None:
            item = event.item
            if not isinstance(item, ChatMessage) or item.role != "assistant":
                return
            text = item.text_content
            if not text:
                return
            asyncio.create_task(_publish_agent_transcript(ctx.room, text))

        disconnect = asyncio.Event()
        ctx.room.on("disconnected", lambda *_: disconnect.set())

        try:
            await session.start(
                agent=Agent(
                    instructions=(
                        "You are a friendly voice assistant. Greet the caller, then "
                        "answer their question briefly in one or two sentences."
                    ),
                ),
                room=ctx.room,
            )

            model_id = os.environ.get(
                "GEMINI_MODEL", "gemini-2.5-flash-native-audio-preview-12-2025"
            )

            with _tracer.start_as_current_span("xray.stage.tts") as span:
                span.set_attribute("xray.stage.tts.provider", "gemini-live")
                span.set_attribute("xray.stage.tts.model", model_id)
                handle = session.generate_reply(
                    instructions="Greet the caller in one short sentence."
                )
                await handle

            _langfuse_step(model_id)

            if xray_session is not None:
                xray_session.record_tool_call(
                    name="get_current_year",
                    args_json="{}",
                    result_json='{"year": 2026}',
                    latency_ms=5,
                )

            await disconnect.wait()
        finally:
            disconnect.set()


async def _publish_agent_transcript(room: rtc.Room, text: str) -> None:
    publication = next(
        (p for p in room.local_participant.track_publications.values() if p.sid),
        None,
    )
    if publication is None or publication.sid is None:
        logger.warning("no published track; cannot forward transcript")
        return
    segment = rtc.TranscriptionSegment(
        id=f"agent-{int(time.time() * 1000)}",
        text=text,
        start_time=0,
        end_time=0,
        final=True,
        language="",
    )
    transcription = rtc.Transcription(
        participant_identity=room.local_participant.identity,
        track_sid=publication.sid,
        segments=[segment],
    )
    try:
        await room.local_participant.publish_transcription(transcription)
    except Exception:
        logger.exception("publish_transcription failed; continuing")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
