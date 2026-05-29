"""Minimal LiveKit Agents worker — Gemini Live (v2v) wired to xray."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import wave
from collections.abc import AsyncIterable
from pathlib import Path

import xray
from google.genai import types as genai_types
from langfuse import observe
from livekit import rtc
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.agents.llm import ChatMessage, function_tool
from livekit.agents.voice.events import ConversationItemAddedEvent
from livekit.plugins import google
from opentelemetry import trace

logger = logging.getLogger("voice-agent")
_tracer = trace.get_tracer("example-voice-agent")

# Gemini 3.1 Live's `generate_reply()` is warn-and-ignored by the
# realtime plugin, so the agent can't speak first via the LLM path.
# Pre-recorded greeting (24kHz mono int16 PCM, generated once via
# Gemini standalone TTS) is published through `session.say(audio=...)`.
# `add_to_chat_ctx=True` (the default) records the greeting text in
# the chat history so the realtime model knows it already greeted.
_GREETING_TEXT = "Hello there! How can I help you today?"
_GREETING_VOICE = "Puck"
_GREETING_WAV_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "agent_greeting.wav"


@observe(as_type="generation", name="example_langfuse_step")
def _langfuse_step(model: str) -> str:
    return f"agent will use {model}"


@function_tool
async def get_current_year() -> dict[str, int]:
    """Return the current calendar year. Call this whenever the user asks
    about today's year, the current year, or what year it is."""
    with _tracer.start_as_current_span("execute_tool") as span:
        span.set_attribute("gen_ai.operation.name", "execute_tool")
        span.set_attribute("gen_ai.tool.name", "get_current_year")
        span.set_attribute("gen_ai.tool.arguments", "{}")
        result = {"year": 2011}
        span.set_attribute("gen_ai.tool.result", json.dumps(result))
        return result


async def _wav_audio_frames(path: Path, frame_ms: int = 20) -> AsyncIterable[rtc.AudioFrame]:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        nch = w.getnchannels()
        sw = w.getsampwidth()
        samples_per_frame = sr * frame_ms // 1000
        while True:
            raw = w.readframes(samples_per_frame)
            if not raw:
                break
            yield rtc.AudioFrame(
                data=raw,
                sample_rate=sr,
                num_channels=nch,
                samples_per_channel=len(raw) // (sw * nch),
            )


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    async with xray.attach(ctx, service_name="example-voice-agent") as xray_session:
        model_id = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-live-preview")
        session = AgentSession(
            llm=google.realtime.RealtimeModel(
                model=model_id,
                voice=_GREETING_VOICE,
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
                        "You are a friendly voice assistant. You have already "
                        "greeted the caller. Answer their question briefly in "
                        "one or two sentences. If the caller asks about the "
                        "current year (or any question whose answer depends on "
                        "the current year), you MUST call the `get_current_year` "
                        "tool and use its result."
                    ),
                    tools=[get_current_year],
                ),
                room=ctx.room,
            )

            await session.say(
                text=_GREETING_TEXT,
                audio=_wav_audio_frames(_GREETING_WAV_PATH),
                allow_interruptions=False,
            )

            _langfuse_step(model_id)

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
