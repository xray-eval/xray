# syntax=docker/dockerfile:1.7
# python:3.12-slim-bookworm — pinned per `.claude/rules/supply-chain.md` §4.
FROM python@sha256:93ab4b7fa528b25124c97bcc755415e60eb671a86b4dbe0328df2fe2d1c1193d

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /workspace

COPY sdk/python /workspace/sdk/python
RUN pip install --upgrade pip && \
    pip install -e "/workspace/sdk/python[livekit]" && \
    pip install \
      "pytest==9.0.3" \
      "pytest-asyncio==1.3.0" \
      "httpx==0.28.1"

COPY examples/livekit-voice-agent/driver /workspace/driver
COPY examples/livekit-voice-agent/fixtures /workspace/fixtures

WORKDIR /workspace/driver
CMD ["pytest", "-v", "-s", "test_e2e.py"]
