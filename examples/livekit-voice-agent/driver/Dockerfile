# syntax=docker/dockerfile:1.7
# python:3.12-slim-bookworm — pinned per `.claude/rules/supply-chain.md` §4.
FROM python@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /workspace

COPY sdk/python /workspace/sdk/python
RUN pip install --upgrade pip && \
    pip install -e "/workspace/sdk/python[livekit]" && \
    pip install \
      "pytest==9.1.1" \
      "pytest-asyncio==1.4.0" \
      "httpx==0.28.1"

COPY examples/livekit-voice-agent/driver /workspace/driver
COPY examples/livekit-voice-agent/fixtures /workspace/fixtures

WORKDIR /workspace/driver
CMD ["pytest", "-v", "-s", "test_e2e.py"]
