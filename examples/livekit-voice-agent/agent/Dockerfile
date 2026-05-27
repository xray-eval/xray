# syntax=docker/dockerfile:1.7
# python:3.12-slim-bookworm — pinned per `.claude/rules/supply-chain.md` §4.
FROM python@sha256:93ab4b7fa528b25124c97bcc755415e60eb671a86b4dbe0328df2fe2d1c1193d

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /workspace

# In-tree SDK first so its layer caches across agent-code edits.
COPY sdk/python /workspace/sdk/python
RUN pip install --upgrade pip && \
    pip install -e "/workspace/sdk/python[livekit]" && \
    pip install \
      "livekit-agents==1.5.9" \
      "livekit-plugins-google==1.5.9" \
      "langfuse==3.9.3"

COPY examples/livekit-voice-agent/agent /workspace/agent
COPY examples/livekit-voice-agent/fixtures /workspace/fixtures

WORKDIR /workspace/agent
CMD ["python", "main.py", "start"]
