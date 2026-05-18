"""End-to-end example: a single Conversation against a LiveKit room.

Run with::

    export LIVEKIT_URL=wss://your-project.livekit.cloud
    export LIVEKIT_API_KEY=...
    export LIVEKIT_API_SECRET=...
    python examples/booking_happy_path.py
"""

from __future__ import annotations

import os

from xray import Conversation, Turn, expect_agent_turn, run
from xray.conversation import AgentResponse
from xray.runtime.livekit import LiveKitRuntime


def confirms_booking(agent: AgentResponse) -> bool:
    return "confirmed" in agent.transcript.lower()


def main() -> None:
    conv = Conversation(
        id="booking-happy-path",
        title="Books a table for two",
        turns=[
            Turn.user("Hi, I'd like to book a table for two at 7pm.", key="u0"),
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
