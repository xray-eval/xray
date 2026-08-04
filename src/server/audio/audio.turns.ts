import { AudioTurnsInvariantError } from "./audio.errors.ts";
import type { DerivedTurn, VadSegment } from "./audio.types.ts";

interface Utterance {
	readonly role: "user" | "agent";
	readonly segments: readonly VadSegment[];
}

/**
 * Derive turn boundaries from per-channel VAD output.
 *
 * Each channel's segments are grouped into utterances first, then utterances
 * become turns ordered by voice onset. Per turn:
 *   - `turnStartMs` = the moment the other side's voice last ended, clamped to
 *     this turn's own voice onset (0 for the very first turn).
 *   - `turnEndMs` / `voiceEndMs` = this utterance's last segment end.
 *   - `voiceStartMs` = this utterance's first segment start.
 *
 * A pause inside one channel splits it into two turns only when the other
 * channel *took the floor* across that pause — see `floorChangedHands`. Pause
 * length plays no part: a real recording (replay 6036f881) has a 1530ms pause
 * inside one agent answer, while the snapshot fixture has a genuine turn
 * boundary across a 1380ms gap, so the pause that must hold an utterance
 * together is longer than the gap that must break one.
 *
 * The previous approach — merging both channels into one list sorted by start
 * time and cutting on every role change — mis-attributed barge-ins. An agent
 * resuming at the same millisecond the user cuts in had its own tail sorted
 * after the user's segment (purely from concatenation order feeding a stable
 * sort), which opened a phantom turn and ended the interrupted turn before the
 * interruption: `yielded_within_ms` then reported "no interruption landed" for
 * an agent that had in fact stopped 330ms after being cut off. See issue #126.
 */
export function deriveTurns(user: VadSegment[], agent: VadSegment[]): DerivedTurn[] {
	const utterances = [
		...groupUtterances(user, agent, "user"),
		...groupUtterances(agent, user, "agent"),
	];
	// Onset order, and on an exact tie the user goes first: the scripted driver
	// plays the user's audio, so the user is the one who started that moment.
	utterances.sort((a, b) => {
		const byOnset = onsetOf(a) - onsetOf(b);
		if (byOnset !== 0) return byOnset;
		return a.role === b.role ? 0 : a.role === "user" ? -1 : 1;
	});

	const turns: DerivedTurn[] = [];
	const lastVoiceEndMs: Record<"user" | "agent", number> = { user: 0, agent: 0 };
	for (const utterance of utterances) {
		const opposite = utterance.role === "user" ? "agent" : "user";
		const turn = buildTurn(turns.length, utterance, lastVoiceEndMs[opposite]);
		turns.push(turn);
		lastVoiceEndMs[utterance.role] = turn.voiceEndMs;
	}
	return turns;
}

function groupUtterances(
	own: readonly VadSegment[],
	other: readonly VadSegment[],
	role: "user" | "agent",
): Utterance[] {
	const sorted = [...own].sort((a, b) => a.startMs - b.startMs);
	const utterances: Utterance[] = [];
	let segments: VadSegment[] = [];
	let openStartMs = 0;
	let openEndMs = 0;
	for (const segment of sorted) {
		if (segments.length === 0) {
			segments = [segment];
			openStartMs = segment.startMs;
			openEndMs = segment.endMs;
			continue;
		}
		if (floorChangedHands(openStartMs, openEndMs, segment.startMs, other)) {
			utterances.push({ role, segments });
			segments = [segment];
			openStartMs = segment.startMs;
			openEndMs = segment.endMs;
			continue;
		}
		segments.push(segment);
		openEndMs = Math.max(openEndMs, segment.endMs);
	}
	if (segments.length > 0) utterances.push({ role, segments });
	return utterances;
}

/**
 * Minimum overlap for the other channel to have taken the floor while it is
 * *still speaking* as we resume — the ambiguous case, where we are either
 * answering them or talking over them. Mirrors LiveKit's
 * `min_interruption_duration` default of 0.5s: the speech that makes an
 * interruption real is the speech that makes a turn boundary real.
 *
 * The committed fixtures pin this to **(300, 540]** — measured by sweeping the
 * constant and re-running `audio.turns.test.ts`, not estimated:
 *   - at 300 and below, "keeps an utterance whole when the other party
 *     interrupted across its pause" and the replay 2a8fd70b case break: a speaker
 *     talked over mid-pause starts fragmenting, and with it the evidence that it
 *     never yielded;
 *   - at 541 and above, "derives the same turns whether the tail lands before,
 *     on, or after the barge-in" breaks. The binding quantity is the 540ms agent
 *     interjection in that fixture; past it the three tail positions stop
 *     agreeing, because the earliest one contributes 1ms of extra held time.
 * 500 sits inside that window and is anchored to LiveKit's default rather than to
 * the midpoint.
 */
const FLOOR_HANDOFF_MS = 500;

/**
 * Shortest completed stretch of speech that counts as the other party actually
 * saying something, rather than a fragment of their ongoing speech that VAD
 * happened to isolate. "Ja." runs 300-400ms; the fragments a mis-detected
 * utterance leaves behind measure 80-100ms (VAD's own `minSegmentMs` is 80).
 *
 * The committed fixtures cap this at **400** (measured: at 401 the short-reply
 * test merges the answers around a 400ms "Ja."). Nothing pins the lower end — it
 * passes down to VAD's own 80ms floor — so the value is chosen for meaning, not
 * fitted: a fifth of a second is about the shortest thing a person says on
 * purpose.
 *
 * It is a soft floor, and knowingly so: it measures a VAD segment's **extent**,
 * and `audio.vad.ts` merges voiced runs up to `mergeGapMs` apart *before* the
 * min-segment filter, so clustered noise inflates. Measured: two 30ms bursts
 * 200ms apart report a 270ms segment carrying 60ms of sound. Clean recordings
 * (every scripted replay) don't produce that; a live human mic in a noisy room
 * might. Tightening it needs per-segment voiced duration out of the VAD, which
 * is a schema change, not a constant change.
 *
 * Known trade-off for `xray.run_live`, where the user channel is a real human
 * microphone rather than scripted audio: a 200-400ms backchannel ("mm-hmm")
 * landing inside an agent pause reads as a completed utterance here, so it
 * splits the agent's answer — while `MIN_INTERRUPTION_MS` in `calculate-metrics`
 * declines to call the same sound a barge-in. Scripted replays can't produce
 * that (their user channel only speaks when the script says so). Raising this to
 * 500 would trade it for merging genuine short replies, which is worse: those
 * leave the recording a turn short of the script and fail the whole replay on
 * spec_vad_mismatch instead of evaluating it.
 */
const MIN_UTTERANCE_MS = 200;

/**
 * The VAD frame these segment bounds were measured at (`audio.vad.ts`). Used as
 * slack when comparing two segment edges for "who stopped first": a difference
 * smaller than one frame is below the resolution of the measurement.
 */
const VAD_FRAME_MS = 30;

/**
 * Did the other channel take the floor during our pause? Which question to ask
 * depends on whether they are still talking at the moment we resume:
 *
 * - **They have gone quiet.** Then they were speaking when we stopped and have
 *   since finished: we yielded, they had their say, and our resumption answers
 *   them. Gated by `MIN_UTTERANCE_MS` — a short reply is still a reply — unless
 *   their stop was itself a yield to *us*: a completed segment straddling our own
 *   onset means we took the floor off them mid-utterance, and a caller who barges
 *   in and draws breath still holds it. "Speaking when we stopped" is what keeps a
 *   speaker who talked *over* the other side and carried on afterwards from being
 *   cut at its own next breath — there, the pause is mid-utterance and the other
 *   side had long since finished.
 * - **They are still talking.** Then we are either answering them or talking
 *   over them, and only how long they held our pause separates the two:
 *   `FLOOR_HANDOFF_MS`.
 *
 * The asymmetry in those two bars isn't arbitrary: it tracks the difference
 * between a reply and a backchannel. Replies land in silence and end there;
 * backchannels ride over the other speaker's ongoing speech. So speech that is
 * still running when we resume has to clear a much higher bar to count as having
 * taken the floor from us.
 *
 * Within each branch, deliberately no exact test of where their segment's edges
 * fall. Edge tests are discontinuous where the real ambiguity lives, in both
 * directions: an agent resuming one VAD frame after the user cut in is still the
 * tail of the interrupted utterance, yet "their onset landed inside my pause"
 * would open a new turn; and a user line ending one frame before the agent's
 * voice stops is still a completed barge-in, yet a strict "they stopped before we
 * did" would merge the agent's next answer into the interrupted turn and bill it
 * seconds of yield. `VAD_FRAME_MS` of slack puts that comparison inside one VAD
 * frame — the resolution the segment bounds were measured at in the first place,
 * so neither side of it is a claim the audio can actually support.
 *
 * Choosing *between* the branches is an exact edge test, and it does flip
 * structure: a frame of double-talk at the resumption instant moves an utterance
 * held for 200-500ms from "they finished, we reply" to "genuine overlap, keep the
 * utterance whole". That one is left sharp on purpose — the two sides are
 * physically different situations and both readings are defensible, unlike the
 * within-branch edges above, where one side was simply wrong. The test
 * "switches branch on double-talk at the resumption instant" pins where it sits
 * so a refactor can't move it unnoticed.
 */
function floorChangedHands(
	utteranceStartMs: number,
	gapStartMs: number,
	gapEndMs: number,
	other: readonly VadSegment[],
): boolean {
	const stillSpeaking = other.some(
		(segment) => segment.startMs <= gapEndMs && segment.endMs > gapEndMs,
	);
	if (!stillSpeaking) {
		return other.some(
			(segment) =>
				segment.endMs >= gapStartMs - VAD_FRAME_MS &&
				segment.endMs <= gapEndMs &&
				segment.endMs - segment.startMs >= MIN_UTTERANCE_MS &&
				// Their stopping is a yield, not a handoff, when we took the floor off
				// them mid-utterance: a caller who barges in and draws breath still
				// holds the floor, so "Wait— stop!" stays one turn. Without this, both
				// halves fall under the barge-in minimum and the interruption vanishes
				// from the metrics.
				!(segment.startMs < utteranceStartMs && segment.endMs > utteranceStartMs),
		);
	}
	let heldMs = 0;
	for (const segment of other) {
		const from = Math.max(segment.startMs, gapStartMs);
		const to = Math.min(segment.endMs, gapEndMs);
		if (to > from) heldMs += to - from;
	}
	return heldMs >= FLOOR_HANDOFF_MS;
}

function onsetOf(utterance: Utterance): number {
	const first = utterance.segments[0];
	if (first === undefined) {
		throw new AudioTurnsInvariantError("utterance grouped with no segments");
	}
	return first.startMs;
}

function buildTurn(idx: number, utterance: Utterance, prevOtherEndMs: number): DerivedTurn {
	const { segments, role } = utterance;
	const first = segments[0];
	if (first === undefined) {
		throw new AudioTurnsInvariantError("buildTurn called with empty segments");
	}
	const voiceEndMs = segments.reduce((end, segment) => Math.max(end, segment.endMs), first.endMs);
	return {
		idx,
		role,
		// Clamp to this turn's voice onset so an interrupting turn (voice starting
		// before the other side stopped) can't report a start later than its own
		// first word. Without overlap `prevOtherEndMs` is already ≤ the voice onset,
		// so the `min` is a no-op for the common path.
		turnStartMs: Math.min(prevOtherEndMs, first.startMs),
		turnEndMs: voiceEndMs,
		voiceStartMs: first.startMs,
		voiceEndMs,
	};
}
