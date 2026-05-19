"""End-to-end example: a single Conversation against a LiveKit room.

Run with::

    export LIVEKIT_URL=wss://your-project.livekit.cloud
    export LIVEKIT_API_KEY=...
    export LIVEKIT_API_SECRET=...
    export OPENAI_API_KEY=...   # needed for kind="tts" user turns
    python examples/booking_happy_path.py

The Conversation below uses TTS for the user turn — the SDK calls
OpenAI directly using OPENAI_API_KEY and caches the synth in
``~/.cache/xray-py/<conv_id>/<fingerprint>.wav`` so re-runs are
deterministic. Swap to ``RecordedAudio(path="...wav")`` if you'd
rather ship pre-recorded audio.
"""

from __future__ import annotations

import os

from xray import Conversation, Turn, expect_agent_turn, run
from xray.conversation import AgentResponse, TtsAudio
from xray.runtime.livekit import LiveKitRuntime


def confirms_booking(agent: AgentResponse) -> bool:
    return "confirmed" in agent.transcript.lower()


def main() -> None:
    conv = Conversation(
        id="booking-happy-path",
        title="Books a table for two",
        turns=[
            Turn.user(
                "Hi, I'd like to book a table for two at 7pm.",
                key="u0",
                audio=TtsAudio(),
            ),
            expect_agent_turn(
                key="a0",
                assertion=confirms_booking,
                assertion_name="confirms_booking",
            ),
        ],
    )

    runtime = LiveKitRuntime(
        url=os.environ["LIVEKIT_URL"],
        api_key=os.environ["LIVEKIT_API_KEY"],
        api_secret=os.environ["LIVEKIT_API_SECRET"],
        room="booking-test-room",
    )

    result = run(
        conversation=conv,
        runtime=runtime,
        xray_url=os.environ.get("XRAY_URL", "http://localhost:8080"),
        run_config={"model": "gpt-4o", "temperature": 0.5},
    )
    print(f"replay {result.id} status={result.status}")


if __name__ == "__main__":
    main()
