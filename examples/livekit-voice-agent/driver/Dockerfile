# syntax=docker/dockerfile:1.7
# python:3.12.13-slim-bookworm — pinned per `.claude/rules/supply-chain.md` §4.
# The patch tag, not the floating `3.12-slim-bookworm`: the two diverged when the
# 3.12 line moved past 3.12.13, and only the patch tag's rebuild clears the 30-day bar.
FROM python@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2

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
