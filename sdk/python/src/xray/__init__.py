"""xray-py — Python SDK for xray.

Public surface:

- ``xray.Conversation`` / ``xray.Turn`` — test-definition primitives.
- ``xray.Assertion`` / ``xray.Judge`` — declarative checks the server
  runs after the replay completes.
- ``xray.ReplayResult`` — what ``xray.run(...)`` returns: the server's
  pass/fail verdict plus per-assertion / per-judge outcomes + per-turn
  metrics.
- ``xray.RunConfig`` — typed per-replay configuration.
- ``xray.run(...)`` — orchestrator: POST the spec, POST the replay, drive
  the runtime, upload audio, wait for the server's evaluation, return
  the verdict.
- ``xray.attach(ctx, ...)`` — async-CM for LiveKit Agents worker
  entrypoints. Auto-binds the replay context from the JWT's ``xray``
  attribute, installs the OTLP/JSON exporter, force-flushes spans on
  exit.
- ``xray.otel`` — low-level OTEL pipeline helpers if you need to wire
  things manually (``install``, ``XraySpanExporter``,
  ``XrayBaggageSpanProcessor``).
- ``xray.runtime.livekit.LiveKitRuntime`` — user-side driver.
"""

from xray.config import RunConfig
from xray.conversation import (
    AgentResponse,
    Assertion,
    AssertionOutcome,
    Conversation,
    EvaluationStatus,
    Judge,
    JudgeOutcome,
    ModelUsage,
    RecordedAudio,
    ReplayResult,
    Role,
    ToolCall,
    TtsAudio,
    Turn,
    TurnMetrics,
)
from xray.errors import ReplayEvaluationError, XrayError
from xray.instrument import XraySession, attach
from xray.orchestrator import run

__all__ = [
    "AgentResponse",
    "Assertion",
    "AssertionOutcome",
    "Conversation",
    "EvaluationStatus",
    "Judge",
    "JudgeOutcome",
    "ModelUsage",
    "RecordedAudio",
    "ReplayEvaluationError",
    "ReplayResult",
    "Role",
    "RunConfig",
    "ToolCall",
    "TtsAudio",
    "Turn",
    "TurnMetrics",
    "XrayError",
    "XraySession",
    "attach",
    "run",
]

__version__ = "0.0.1"
