# xray-py

Python SDK for [xray](https://github.com/xray-eval/xray) — an open-source,
self-hosted replay/eval framework for LiveKit voice agents.

> **Alpha.** Wire and API surface can break between minor versions.

## Install

```bash
pip install "xray-py[livekit]"
```

The `[livekit]` extra pulls in the `livekit` client + API; drop it if you
implement your own `Runtime`. Add `[live]` for the OS-mic `run_live` session.

## Quickstart

```python
import asyncio
import os

from xray import Assertion, Conversation, Judge, RunConfig, Turn, format_failures, run
from xray.runtime.livekit import LiveKitRuntime


async def main() -> None:
    conv = Conversation(
        name="books-a-table-for-two",
        turns=[
            Turn.user("Hi, I'd like to book a table for two at 7pm.", key="u0"),
            Turn.agent(
                key="a0",
                assertions=(
                    Assertion.contains("confirmed"),
                    Assertion.tool_called("reserve_table"),
                    Assertion.max_latency_ms(2_000),
                ),
            ),
        ],
        judges=(Judge.text_match("agent confirms a reservation for two", pass_score=80),),
    )

    runtime = LiveKitRuntime(
        url=os.environ["LIVEKIT_URL"],
        api_key=os.environ["LIVEKIT_API_KEY"],
        api_secret=os.environ["LIVEKIT_API_SECRET"],
        room="booking-test-room",
    )

    result = await run(
        conversation=conv,
        runtime=runtime,
        xray_url="http://localhost:8080",
        run_config=RunConfig(model="gpt-4o", temperature=0.5),
    )
    assert result.passed, format_failures(result)


asyncio.run(main())
```

Wire your agent's worker entrypoint in one block:

```python
import xray

async def entrypoint(ctx):
    await ctx.connect()
    async with xray.attach(ctx, service_name="my-agent"):
        ...  # your existing agent code — unchanged
```

`attach` reads the replay context from the joining participant's JWT `xray`
attribute, installs an OTLP/JSON exporter pointed at xray, and force-flushes
spans on exit. Note: **TTS for user turns is done server-side** — the SDK reads
no provider key and only `XRAY_OTLP_ENDPOINT` from its environment.

## Full reference

This README is a quickstart. The authoritative SDK reference — every export,
signature, runtime, and error — lives in the main repo:

- **[docs/sdk-python.md](https://github.com/xray-eval/xray/blob/main/docs/sdk-python.md)** — the SDK reference.
- [docs/integrate.md](https://github.com/xray-eval/xray/blob/main/docs/integrate.md) — end-to-end integration walkthrough.
- [docs/wire-contract.md](https://github.com/xray-eval/xray/blob/main/docs/wire-contract.md) — the OTLP attribute contract.

## License

[Elastic License 2.0](https://github.com/xray-eval/xray/blob/main/LICENSE).
