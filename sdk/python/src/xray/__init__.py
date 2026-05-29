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
- ``xray.run_live(...)`` — live-session orchestrator: no authored
  Conversation, the user talks to the agent over the mic; records the
  session and uploads it as a Replay under a fresh ``live`` Conversation.
  Stop with Ctrl+C. See ``xray.runtime.livekit_live.LiveKitLiveRuntime``.
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
    format_failures,
)
from xray.errors import ReplayEvaluationError, XrayError
from xray.instrument import XraySession, attach
from xray.orchestrator import run, run_live
from xray.runtime.sip import SimulatedSipCall

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
    "SimulatedSipCall",
    "ToolCall",
    "TtsAudio",
    "Turn",
    "TurnMetrics",
    "XrayError",
    "XraySession",
    "attach",
    "format_failures",
    "run",
    "run_live",
]

__version__ = "0.0.1"
