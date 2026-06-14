# 0001 · Timeline clock alignment + timeline-native span model

Status: **implemented** (server + SDK + client; verified: `bun test` 680 pass, `tsc` clean, biome clean, SDK `pytest` 93 pass, `pyright --strict` clean)
Branch: `feat/metrics-eval`

> Spec numbering: no prior spec exists on this branch; `0001` chosen to
> match the per-feature convention used on earlier branches. Renumber if
> a global sequence is adopted.

---

## 1 · The bug, precisely

xray computes per-turn metrics and attributes OTLP spans (`tool_calls`,
`model_usage`) to turns by mapping each span's wall-clock timestamp onto
the **audio timeline** (ms from the recording's `t=0`). The map it uses
is wrong:

```ts
// analyze-replay.processor.ts:346  &  calculate-metrics.processor.ts:259
offsetMs = Date.parse(span.started_at) − Date.parse(replays.started_at)
```

`replays.started_at` is stamped at **replay-row creation** (POST
`/v1/replays`, `replays.service.ts:65`), which happens **before** the
driver connects the LiveKit room, waits for the agent to join
(`livekit.py:219`), publishes the track, and begins the first turn.
Audio `t=0` is `min(segment.started_at)` — the first turn's driver-clock
`time.time()` (`livekit.py:581`). The two instants differ by the entire
connect + agent-join + publish latency.

### Evidence (authentic snapshot)

`snapshot/xray.db`, replay `7b8e2770…`:

| quantity | wall-clock |
|---|---|
| `replays.started_at` | `14:31:28.688` |
| first `xray.turn` span ≈ audio `t=0` | `14:31:31.023` |

**Gap = 2335 ms**, run-dependent and unbounded (scales with agent
cold-start). Worked example — tool call `get_current_year` at
`14:31:37.265`, VAD turn windows `t0[360,2190) t1[2550,4680)
t2[7110,11070)`:

- code offset `37265 − 28688 = 8577` → lands in `t2` voice window
- true offset `37265 − 31023 = 6242` → lands in `t2`'s pre-voice gap

The two errors (wrong origin; voice-window-only matching) happen to
partially cancel here. They do not in general.

### Why the server can't fix it alone

At the driver→server boundary the driver observes a **join**:
`(wall_clock ↔ audio_sample ↔ turn_structure)`. It ships raw audio bytes
(no timestamps) + raw OTLP spans (wall-clock, mixed clock domains) and
**discards the join**. `started_at` is a server-clock stamp of an
unrelated event; it does not contain the join. The fix must **preserve
the join across the boundary** — the driver is the only party that knows
audio `t=0` in wall-clock terms.

### Clock domains in play

| Domain | Owns | Notes |
|---|---|---|
| Server | `replays.started_at` | unrelated to audio; row-creation time |
| Driver (test runner) | the mixdown, audio `t=0`; `xray.turn` spans | the join lives here |
| Agent under test | `gen_ai.*` / tool spans | separate process; the timestamps we attribute |

Runs are short → clock-rate drift is negligible → the correction is a
pure **offset**, not an affine slope.

---

## 2 · Decisions (resolved with the maintainer)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Agent-clock correlation | **Co-located anchor.** Driver ships audio `t=0`; assume agent clock ≈ driver clock. **No** out-of-range flagging. | Common setup is one host. Spans legitimately fire outside any turn's audio (prep, speculative gen), so "outside the audio" is not an error condition. |
| D2 | Turn source | **VAD-authoritative, unchanged.** | Required for live mode; out of scope to revisit here. |
| D3 | Anchor granularity | **Single recording-start anchor.** | One offset map for the whole run; driver already knows `t=0`. |
| D4 | `ttft_ms` meaning | **Model TTFT from GenAI semconv, optional.** | The value is a same-clock delta — correlation-free. Treated as one more optional extracted field, no special pipeline. |
| D5 | Anchor wire surface | **`X-Recording-Started-At` header on POST `/audio`.** | The anchor is a property *of the audio*; persisted once at upload, read by the chain. |
| D6 | Refactor scope | **Drop stored `turn_idx`; delete `backfillTurnIdx`.** Spans carry a read-derived `audio_offset_ms`; display by timeline overlap; assertions compute per-turn membership at eval time. | A stored `turn_idx` denormalizes a spatial fact the timeline already encodes, and forces one lossy global attribution rule. |
| D7 | Per-turn assertion window | **`[turnStartMs, turnEnd)`** — the agent turn's *own* window (tiles the timeline). | Strict: a too-early (speculative during the user's turn) or too-late tool call lands in a neighbour tile → flagged. Speculative-execution leniency deferred to an explicit eval-SDK opt-in. |

---

## 3 · Design

### 3.1 The anchor

- New column **`replays.recording_started_at`** (`text`, nullable,
  ISO-8601 UTC).
- POST `/audio` reads header **`X-Recording-Started-At`**, Valibot-validated
  (ISO datetime), persists it on the replay row alongside `audio_path`.
- **Absent header** (legacy SDK / unset): store `null`. Degrade gracefully
  — no offset, no per-turn tool attribution (see §3.4). Never fall back
  to `started_at`. New SDK always sends it.

### 3.2 Unified timeline — `audio_offset_ms`

A single pure helper maps wall-clock → audio offset:

```ts
// audio_offset_ms = parse(startedAtIso) − parse(recordingStartedAtIso)
//   → number | null  (null if either timestamp is missing/unparseable)
```

Derived **at read** for every `span` / `tool_call` / `model_usage` from
data already stored (`started_at` on the row + `recording_started_at` on
the replay). **Not** a stored column — single source of truth, cannot
drift. Used by both the response builder (inspector timeline) and the
assertion evaluator.

The inspector renders all spans + VAD turns on one ms axis; turn overlap
is **visual**, not a stored foreign key. A span in a gap (prep /
speculative) renders in the gap and reads correctly.

### 3.3 TTFT — optional, no special handling

- `gen-ai-semconv.ts` extracts `gen_ai.response.time_to_first_chunk`
  (seconds, float; semconv stability *Development* — pin against the
  emitting instrumentation's semconv version) → `ttftMs = round(s*1000)`.
  Added to `ExtractedModelUsage`. Null when the span doesn't carry it
  (the common case today — the example v2v agent emits none).
- New column **`model_usage.ttft_ms`** (`integer`, nullable). Written by
  `persistExtracted`. Rides the timeline as a model-call attribute.
- **Removed** from `replay_metrics` entirely.

### 3.4 Assertions — eval-time membership

**Scope: this window governs `tool_called` / `tool_not_called` /
`tool_args_match` / `max_ttft_ms` evaluation only.** Every recognized
`tool_call` / `model_usage` / span is still recorded *unconditionally*
(`otlp.service.ts` `persistExtracted` — no turn association at rest, since
D6 drops `turn_idx`) and rendered on the timeline at its true
`audio_offset_ms`, in-turn or not. The window never filters storage or
display: a speculative tool call that fires during the user's turn is
still stored and still shown — it just doesn't count toward the agent
turn's assertion.

`buildAssertionContext` (`evaluate-replay.processor.ts`) computes each
turn's tool/model rows on demand:

- A `tool_call` / `model_usage` row belongs to turn `N` iff its
  `audio_offset_ms ∈ [turnStartMs_N, turnEndMs_N)` — the turn's **own**
  window from `deriveTurns`, where `turnStartMs` = the previous
  (opposite-role) turn's `voiceEndMs` (0 if none) and `turnEndMs` = this
  turn's `voiceEndMs`. Since `turnStartMs_N = voiceEndMs_{N-1}`, the
  windows **tile** the timeline with no gaps or overlap — every call maps
  to **exactly one** turn.
- **Strict by design.** A call that fires *before* the user stopped
  (speculative-during-user-turn) or *after* the agent finished lands in a
  neighbouring turn's tile → **not** counted for turn `N` → `tool_called`
  flags it. A mistimed tool call is a real agent bug worth surfacing. The
  pre-voice "thinking" gap stays in-turn (it sits in `N`'s tile, after the
  user stopped).
- `max_ttft_ms` sources `ttftMs` from the **earliest in-window**
  `model_usage` row (the first LLM call's perceived first-chunk latency).
- **No `recording_started_at` → no offsets → tool/ttft assertions
  `errored`** with a clear message (`"no recording anchor; cannot
  attribute spans to turns"`). Honest, not silently failing.

> Future opt-in: if speculative execution outside the bot turn proves
> common, add an explicit eval-SDK knob (e.g. an assertion param
> `allow_speculative`, or a widened window) rather than loosening the
> default. Strict-by-default; widen on demand.

### 3.5 calculate-metrics simplification

With TTFT gone from `replay_metrics`, the stage no longer reads `spans`
or `recording_started_at`. It computes only audio-derived, single-frame
metrics — both already correct:

- `agent_response_ms` = `voiceStartMs − priorUserVoiceEndMs`
- `interrupted` / `interruption_start_ms`

`computeMetrics` loses its `ttftSpans` + `replayStartMs` params and the
`ttftFor` helper is deleted.

---

## 4 · Change surface

### Deletions

- `analyze-replay.processor.ts`: `backfillTurnIdx`, `turnIdxForStartedAt`,
  and all `tool_calls` / `model_usage` writes from this stage.
- `calculate-metrics.processor.ts`: `ttftFor`; `ttftSpans` + `replayStartMs`
  plumbing.
- `model_usage.turn_idx`, `tool_calls.turn_idx` columns.
- `replay_metrics.ttft_ms` column.

### Server

- `store/schema.ts` + migration: `+replays.recording_started_at`,
  `+model_usage.ttft_ms`, `−*.turn_idx`, `−replay_metrics.ttft_ms`.
- `audio.router.ts` / `audio.service.ts` / `audio.types.ts`: parse + persist
  the header.
- `replays/timeline.ts` (new small slice): the `audio_offset_ms` helper +
  the membership-window predicate. Co-located test.
- `otlp/vocabularies/gen-ai-semconv.ts`: extract `time_to_first_chunk`.
- `otlp.service.ts` (`persistExtracted`): write `model_usage.ttft_ms`; stop
  writing `turn_idx`.
- `evaluate-replay.processor.ts`: eval-time membership; ttft from model_usage.
- `replays.service.ts` + `replays.types.ts`: response shapes (§5).

### Wire contract (breaking)

| Schema | Change |
|---|---|
| `ToolCallResponse` | −`turn_idx`, +`audio_offset_ms` (nullable) |
| `ModelUsageResponse` | −`turn_idx`, +`audio_offset_ms` (nullable), +`ttft_ms` (nullable) |
| `TurnMetricsResponse` | −`ttft_ms` |
| POST `/audio` | +`X-Recording-Started-At` request header (optional) |

### SDK

- `RuntimeResult`: +`recording_started_at_epoch: float | None` (the mixdown
  `t=0`, already computed in `write_stereo_mixdown` / `write_live_mixdown`).
- `livekit.py`: return it from `run()`.
- `orchestrator.py` `_upload_replay_audio`: send the `X-Recording-Started-At`
  header (ISO from the epoch).

### Client

- Inspector: render spans on the shared timeline by `audio_offset_ms`;
  drop the per-turn `turn_idx` grouping for tool/model rows; surface
  `model_usage.ttft_ms` when present.

---

## 5 · Test plan (TDD — tests land red first)

- **Regression (the decisive one):** evaluate-replay with
  `recording_started_at` deliberately ≠ `started_at` (a multi-second gap) +
  spans whose wall-clock matches the agent's real emit time → assert tool
  calls attribute to the correct turn. This is the case **no current test
  exercises** — today's fixtures bake `span = started_at + offset`
  (`calculate-metrics.processor.test.ts:89`), encoding the bug.
- gen-ai-semconv: `time_to_first_chunk` → `ttft_ms` (present / absent / unit).
- timeline helper: offset math; null when either timestamp missing.
- membership tiling `[turnStartMs, turnEndMs)` — exactly-one-turn; a
  speculative-during-user-turn call lands in the user tile and is
  **flagged** for the agent turn (`tool_called` fails); no-anchor →
  `errored`.
- audio router: header parse (valid / malformed / absent).
- store migration test.
- Re-point / simplify calculate-metrics + analyze-replay tests (backfill gone).

---

## 6 · Risks & accepted assumptions

- **Co-located clocks (D1).** Agent on a different, non-NTP-synced host →
  timeline positions and tool attribution skew, **silently** (no flag, per
  D1). Documented; revisit with audio cross-correlation or trace-context
  propagation if distributed runs become real.
- **VAD real-audio accuracy.** Every remaining audio-frame metric
  (`agent_response_ms`, `interrupted`) and every assertion window rests on
  VAD, currently calibrated on synthetic sines only. Unchanged here, but now
  the *sole* dependency. Separate follow-up.
- **TTFT availability.** Depends on the dev's instrumentation emitting the
  experimental `gen_ai.response.time_to_first_chunk`. Null otherwise.
  Accepted (D4).
- **No anchor (legacy SDK).** Timeline + tool/ttft assertions degrade to
  null / `errored`. New SDK always sends the header.

## 7 · Out of scope

- Turn-source redesign (driver-declared / hybrid) — D2.
- Distributed-clock correlation (cross-correlation / trace propagation).
- `xray.stage.stt` / `xray.stage.tts` → stage-latency metrics.
- Real-audio VAD calibration.
