"""Live mic session against the example voice agent.

Unlike `test_e2e.py` (a scripted, headless replay), this is an interactive
session: you talk to the agent through your microphone and hear it reply
through your speakers, then the whole exchange is uploaded to xray as a
Replay you can inspect.

Run it on your HOST — it needs real microphone + speaker access, so it
does NOT run inside Docker like the scripted driver does.

    # 1. Boot the stack (livekit + xray + agent) in another shell and leave
    #    it running (wait for "registered worker"):
    cd examples/livekit-voice-agent
    docker compose up --build

    # 2. Install the SDK with the `livekit` + `live` extras (livekit drives
    #    the room; live pulls in sounddevice for mic/speaker):
    pip install -e '../../sdk/python[livekit,live]'
    #    (or, once published:  pip install 'xray-py[livekit,live]')

    # 3. Talk to the agent. Press Ctrl+C when you're done — the session is
    #    finalized and uploaded.
    python driver/live_session.py

    # 4. Open the inspector and find your live replay:
    #    http://localhost:8080

Tip: wear headphones. With an open speaker, the mic picks up the agent's
own voice, which both pollutes the recording and feeds back to the agent.
Set XRAY_LIVE_NO_PLAYBACK=1 to record without playback (you won't hear the
agent — useful for a quick smoke test).
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid

import xray
from xray.runtime.livekit_live import LiveKitLiveRuntime

# Surface the runtime's INFO logs (e.g. captured-frame counts) so a silent
# session is diagnosable.
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

# Defaults match examples/livekit-voice-agent/compose.yaml: LiveKit is
# remapped to host port 7890, xray to 8080, with the dev key/secret baked
# into livekit.yaml. Override via env if your stack differs.
DEFAULT_XRAY_URL = "http://127.0.0.1:8080"
DEFAULT_LIVEKIT_URL = "ws://127.0.0.1:7890"
DEFAULT_LIVEKIT_KEY = "devkey"
DEFAULT_LIVEKIT_SECRET = "devsecret32charsminimumlengthxyz123"


async def _run() -> None:
    xray_url = os.environ.get("XRAY_URL", DEFAULT_XRAY_URL)
    runtime = LiveKitLiveRuntime(
        url=os.environ.get("LIVEKIT_URL", DEFAULT_LIVEKIT_URL),
        api_key=os.environ.get("LIVEKIT_API_KEY", DEFAULT_LIVEKIT_KEY),
        api_secret=os.environ.get("LIVEKIT_API_SECRET", DEFAULT_LIVEKIT_SECRET),
        room=f"live-{uuid.uuid4().hex[:8]}",
        play_agent_audio=os.environ.get("XRAY_LIVE_NO_PLAYBACK") != "1",
    )

    print("Connecting… start talking once the agent greets you.")
    print("Press Ctrl+C to end the session.\n")
    result = await xray.run_live(runtime=runtime, xray_url=xray_url)
    print(f"\nSession recorded — replay {result.replay_id}")
    print("Open the inspector to analyze it: http://localhost:8080")


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
