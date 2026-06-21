---
layout: home
title: xray

hero:
  name: xray
  text: See every turn your agent takes.
  tagline: Open-source, self-hosted replay and eval for LiveKit voice agents. Hear what your agent heard. See what it decided. Find where it broke.
  actions:
    - theme: brand
      text: Get started
      link: /quickstart
    - theme: alt
      text: Python SDK
      link: /sdk-python
    - theme: alt
      text: GitHub
      link: https://github.com/xray-eval/xray

features:
  - title: Quick start
    details: Zero to your first replay in five minutes. Copy, paste, run.
    link: /quickstart
    linkText: Start here
  - title: Integrate
    details: Add xray to a LiveKit Agents worker. The full walkthrough.
    link: /integrate
    linkText: Walkthrough
  - title: Python SDK
    details: The xray-py reference. Conversation, Turn, Assertion, Judge, run, run_live, and attach.
    link: /sdk-python
    linkText: API reference
  - title: Wire contract
    details: The OpenTelemetry spans your agent must emit to be recognized.
    link: /wire-contract
    linkText: OTLP spec
  - title: Architecture
    details: How xray works inside. The processes, the data paths, and storage.
    link: /architecture
    linkText: Read the model
---

## How it fits together

xray works in five steps.

1. **Write a test.** You define a `Conversation` in Python. It holds user turns, a per-turn `Assertion` or two, and an optional `Judge` for the whole conversation.
2. **Run it.** You call `xray.run(...)`. The SDK joins your LiveKit room as the user. It plays the user audio, records the agent's audio and transcript, and uploads one stereo WAV file.
3. **Your agent reports spans.** During the run, your agent emits OpenTelemetry spans. These are small records of what it did. xray matches them to the run by the `xray.replay.id` value and reads the tool calls and model usage.
4. **The server analyzes the recording.** It finds each turn, transcribes it, measures the timings, and runs your assertions and judges. You get back a `ReplayResult`.
5. **You inspect the run.** Open the UI to replay the audio, read each turn, and compare runs side by side.

> **Alpha.** The wire format and the SDK API can change between minor versions. Upgrading wipes your data. Delete `/data/xray.db` before you start a new container.
