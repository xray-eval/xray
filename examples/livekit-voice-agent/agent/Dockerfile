# syntax=docker/dockerfile:1.7
# python:3.12.16-slim-bookworm — pinned per `.claude/rules/supply-chain.md` §4.
# The patch tag, not the floating `3.12-slim-bookworm`: the floating tag already
# points at a newer patch whose image is still inside the 7-day gate. 3.12 is
# security-only, so each patch is taken on the 7-day gate, not the 30-day bar.
FROM python@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337

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
      "livekit-agents==1.8.7" \
      "livekit-plugins-google==1.8.7" \
      "langfuse==4.17.0"

COPY examples/livekit-voice-agent/agent /workspace/agent
COPY examples/livekit-voice-agent/fixtures /workspace/fixtures

WORKDIR /workspace/agent
CMD ["python", "main.py", "start"]
