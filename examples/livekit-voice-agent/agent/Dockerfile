# syntax=docker/dockerfile:1.7
# python:3.12.14-slim-bookworm — pinned per `.claude/rules/supply-chain.md` §4.
# The patch tag, not the floating `3.12-slim-bookworm`: the two diverged when the
# 3.12 line moved past 3.12.14, and only the patch tag's rebuild clears the 30-day bar.
FROM python@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e

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
      "livekit-agents==1.8.2" \
      "livekit-plugins-google==1.8.2" \
      "langfuse==4.15.4"

COPY examples/livekit-voice-agent/agent /workspace/agent
COPY examples/livekit-voice-agent/fixtures /workspace/fixtures

WORKDIR /workspace/agent
CMD ["python", "main.py", "start"]
