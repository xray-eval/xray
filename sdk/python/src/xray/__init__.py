"""xray-py — Python SDK for xray.

Public surface:

- ``xray.Conversation`` / ``xray.Turn`` — test-definition primitives.
- ``xray.RunConfig`` — typed per-replay configuration.
- ``xray.run(...)`` — orchestrator: POST the spec, POST the replay, drive
  the runtime, fetch the rich per-turn view, evaluate assertions/judge.
- ``xray.attach(ctx, ...)`` — async-CM for LiveKit Agents worker
  entrypoints. Auto-binds the replay context from the JWT's ``xray``
  attribute, installs the OTLP/JSON exporter, force-flushes spans on
  exit. Async-CM (not decorator) because LK Agents pickles the
  entrypoint across multiprocessing forkserver boundaries — wrapper
  decorators trip the pickle path.
- ``xray.otel`` — low-level OTEL pipeline helpers if you need to wire
  things manually (``install``, ``XraySpanExporter``,
  ``XrayBaggageSpanProcessor``).
- ``xray.runtime.livekit.LiveKitRuntime`` — user-side driver.
"""

from xray.config import RunConfig
from xray.conversation import (
    AgentResponse,
    Conversation,
    ModelUsage,
    ToolCall,
    Turn,
)
from xray.instrument import XraySession, attach
from xray.orchestrator import RunResult, run

__all__ = [
    "AgentResponse",
    "Conversation",
    "ModelUsage",
    "RunConfig",
    "RunResult",
    "ToolCall",
    "Turn",
    "XraySession",
    "attach",
    "run",
]

__version__ = "0.0.1"
