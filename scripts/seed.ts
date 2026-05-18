// Seed the running xray dev server so the UI has something to render
// without a real LiveKit-Python agent loop.
//
// Creates one Conversation, then N Replays via POST /v1/replays. For each
// Replay it pushes a small synthetic OTLP/JSON batch with a mix of
// vocabularies (xray.assertion, xray.judge, xray.turn, gen_ai.chat,
// gen_ai.execute_tool, langfuse generation) so the inspector exercises
// every panel, then uploads a single full-replay WAV that the client
// segments by per-turn timestamps.
//
// Usage:
//   pnpm dev                              # in one terminal
//   pnpm seed                             # in another — falls back to sine
//   OPENAI_API_KEY=sk-... pnpm seed       # synthesizes real TTS for each turn
//
// Override target via env: XRAY_BASE_URL=http://otherhost:9000 pnpm seed

import * as v from "valibot";

class SeedError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SeedError";
	}
}

class SeedRequestError extends SeedError {
	readonly method: string;
	readonly path: string;
	readonly status: number;
	readonly statusText: string;
	readonly responseBody: string;
	constructor(
		method: string,
		path: string,
		status: number,
		statusText: string,
		responseBody: string,
	) {
		super(`${method} ${path} -> ${status} ${statusText}`);
		this.name = "SeedRequestError";
		this.method = method;
		this.path = path;
		this.status = status;
		this.statusText = statusText;
		this.responseBody = responseBody;
	}
}

const EnvSchema = v.object({
	XRAY_BASE_URL: v.optional(v.string()),
	OPENAI_API_KEY: v.optional(v.string()),
	OPENAI_TTS_MODEL: v.optional(v.string()),
});
const ENV = v.parse(EnvSchema, process.env);
const BASE = ENV.XRAY_BASE_URL ?? "http://localhost:8080";
const TTS_MODEL = ENV.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";

interface SeedTurn {
	role: "user" | "agent";
	text?: string;
	key: string;
}

interface PlayedSegment {
	idx: number;
	role: "user" | "agent";
	key: string;
	transcript: string;
	/** Offset from the replay's startedAt, in milliseconds. */
	startMs: number;
	/** End offset from the replay's startedAt, in milliseconds. */
	endMs: number;
}

const CONVERSATION_ID = "demo-booking-happy-path";
const CONVERSATION_VERSION = "v0001";
const REPLAY_COUNT = 3;

const TURNS: SeedTurn[] = [
	{ role: "user", text: "Hi, I'd like to book a table for two at 7pm.", key: "u0" },
	{ role: "agent", key: "a0" },
	{ role: "user", text: "Anything else I should know?", key: "u1" },
	{ role: "agent", key: "a1" },
];

// Shared source of truth for what the spans say AND what the TTS synthesizes.
// Timings are millisecond offsets from the replay's startedAt; the audio
// helper pads with silence between segments so the on-disk WAV's playhead
// matches the spans.
const PLAYED: PlayedSegment[] = [
	{
		idx: 0,
		role: "user",
		key: "u0",
		transcript: "Hi, I'd like to book a table for two at 7pm.",
		startMs: 0,
		endMs: 2500,
	},
	{
		idx: 1,
		role: "agent",
		key: "a0",
		transcript: "Confirmed — two at 7pm. Anything else I can help with?",
		startMs: 3000,
		endMs: 6500,
	},
	{
		idx: 2,
		role: "user",
		key: "u1",
		transcript: "Anything else I should know?",
		startMs: 7000,
		endMs: 9000,
	},
	{
		idx: 3,
		role: "agent",
		key: "a1",
		transcript: "We hold reservations for 15 minutes past your time — see you then.",
		startMs: 9500,
		endMs: 13000,
	},
];

const TTS_VOICE_FOR_ROLE: Record<"user" | "agent", string> = {
	user: "alloy",
	agent: "verse",
};

async function main() {
	await postConversation();
	for (let i = 0; i < REPLAY_COUNT; i++) {
		const replayId = await postReplay(i);
		await pushOtlp(replayId, i);
		await uploadReplayAudio(replayId, i);
		await patchReplay(replayId, i);
	}
	console.info(`seeded ${REPLAY_COUNT} replays under ${CONVERSATION_ID}`);
}

async function postConversation() {
	const body = {
		id: CONVERSATION_ID,
		version: CONVERSATION_VERSION,
		title: "Books a table for two — happy path",
		turns: TURNS,
	};
	const res = await fetch(`${BASE}/v1/conversations`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new SeedRequestError(
			"POST",
			"/v1/conversations",
			res.status,
			res.statusText,
			await res.text(),
		);
	}
}

async function postReplay(idx: number): Promise<string> {
	const body = {
		conversationId: CONVERSATION_ID,
		conversationVersion: CONVERSATION_VERSION,
		modality: "voice",
		runConfig: {
			model: idx % 2 === 0 ? "gpt-4o" : "gpt-4o-mini",
			temperature: 0.3 + idx * 0.2,
		},
	};
	const res = await fetch(`${BASE}/v1/replays`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new SeedRequestError("POST", "/v1/replays", res.status, res.statusText, await res.text());
	}
	const parsed = v.parse(v.object({ id: v.string() }), await res.json());
	return parsed.id;
}

async function pushOtlp(replayId: string, idx: number) {
	const replayStartMs = Date.UTC(2026, 4, 18 + idx, 12, 0, 0);
	const lastEnd = PLAYED.at(-1)?.endMs ?? 0;
	const judgeStart = lastEnd + 100;
	const body = {
		resourceSpans: [
			{
				resource: {
					attributes: [
						kv("xray.replay.id", replayId),
						kv("xray.conversation.id", CONVERSATION_ID),
						kv("xray.conversation.version", CONVERSATION_VERSION),
						kv("xray.modality", "voice"),
					],
				},
				scopeSpans: [
					{
						scope: { name: "seed", attributes: [] },
						spans: [
							// xray.turn spans — one per played segment. These are what
							// the inspector slices the full-replay WAV by.
							...PLAYED.map((p) =>
								span({
									name: "xray.turn",
									start: replayStartMs + p.startMs,
									end: replayStartMs + p.endMs,
									attrs: {
										"xray.turn.idx": p.idx,
										"xray.turn.role": p.role,
										"xray.turn.key": p.key,
										"xray.turn.transcript": p.transcript,
									},
								}),
							),
							// Per-turn assertion on the first agent reply.
							span({
								name: "xray.assertion",
								start: replayStartMs + 6500,
								end: replayStartMs + 6501,
								attrs: {
									"xray.turn.idx": 1,
									"xray.assertion.name": "confirms_booking",
									"xray.assertion.status": idx === 1 ? "failed" : "passed",
								},
							}),
							// Per-replay judge.
							span({
								name: "xray.judge",
								start: replayStartMs + judgeStart,
								end: replayStartMs + judgeStart + 400,
								attrs: {
									"xray.judge.status": idx === 1 ? "failed" : "passed",
									"xray.judge.score": 100 - idx * 12,
									"xray.judge.reason":
										idx === 1
											? "Agent omitted the confirmation phrase"
											: "Agent confirmed and offered follow-up",
								},
							}),
							// gen_ai chat span for the first agent turn.
							span({
								name: "chat gpt-4o",
								start: replayStartMs + 3000,
								end: replayStartMs + 6000,
								attrs: {
									"gen_ai.operation.name": "chat",
									"gen_ai.system": "openai",
									"gen_ai.request.model": "gpt-4o",
									"gen_ai.usage.input_tokens": 240 + idx,
									"gen_ai.usage.output_tokens": 88 + idx,
								},
							}),
							// gen_ai tool call.
							span({
								name: "execute_tool reserve_table",
								start: replayStartMs + 3500,
								end: replayStartMs + 3900,
								attrs: {
									"gen_ai.operation.name": "execute_tool",
									"gen_ai.tool.name": "reserve_table",
									"gen_ai.tool.arguments": JSON.stringify({ party: 2, time: "19:00" }),
									"gen_ai.tool.result": JSON.stringify({ ok: true, confirmation: "AB123" }),
								},
							}),
							// Langfuse generation — surfaces a different provider for diversity.
							span({
								name: "anthropic-summarize",
								start: replayStartMs + 9700,
								end: replayStartMs + 9900,
								attrs: {
									"langfuse.observation.type": "generation",
									"langfuse.observation.provider": "anthropic",
									"langfuse.observation.model.name": "claude-3-5-sonnet",
									"langfuse.observation.usage_details.input": 18,
									"langfuse.observation.usage_details.output": 7,
								},
							}),
						],
					},
				],
			},
		],
	};
	const res = await fetch(`${BASE}/v1/otlp/v1/traces`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new SeedRequestError(
			"POST",
			"/v1/otlp/v1/traces",
			res.status,
			res.statusText,
			await res.text(),
		);
	}
}

// One audio file per replay (the full mixdown). The UI slices it by
// `replay_turns.started_at`/`ended_at` from the xray.turn spans pushed
// above, so this single WAV plays back per-turn segments in the inspector.
//
// When OPENAI_API_KEY is set, each segment's `transcript` is synthesized
// via OpenAI's `/v1/audio/speech` (PCM, 24 kHz mono) and the segments are
// concatenated with silence padding so the playhead lines up with the
// span timings. Without a key, falls back to a per-turn sine tone — still
// audibly turn-shaped but not speech.
async function uploadReplayAudio(replayId: string, replayIdx: number) {
	const wav = ENV.OPENAI_API_KEY
		? await synthesizeReplayWavViaOpenAI(ENV.OPENAI_API_KEY)
		: synthesizeReplayWavViaSine(replayIdx);
	const res = await fetch(`${BASE}/v1/replays/${replayId}/audio`, {
		method: "POST",
		headers: { "content-type": "audio/wav" },
		body: new Blob([wav], { type: "audio/wav" }),
	});
	if (!res.ok) {
		throw new SeedRequestError(
			"POST",
			`/v1/replays/${replayId}/audio`,
			res.status,
			res.statusText,
			await res.text(),
		);
	}
}

async function patchReplay(replayId: string, idx: number) {
	const body = {
		status: idx === 2 ? "failed" : "completed",
		failureReason: idx === 2 ? "runtime_error" : null,
		finishedAt: new Date(Date.UTC(2026, 4, 18 + idx, 12, 0, 15)).toISOString(),
		transcript: PLAYED.map((p) => `${p.role === "user" ? "User" : "Agent"}: ${p.transcript}`).join(
			"\n",
		),
	};
	const res = await fetch(`${BASE}/v1/replays/${replayId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new SeedRequestError(
			"PATCH",
			`/v1/replays/${replayId}`,
			res.status,
			res.statusText,
			await res.text(),
		);
	}
}

// --- audio helpers ---

const TTS_SAMPLE_RATE = 24_000; // OpenAI TTS PCM is fixed at 24 kHz mono.
const SINE_SAMPLE_RATE = 16_000;

/**
 * TTS each segment, drop the bytes at the right offset of a single
 * 24 kHz mono PCM buffer, render to WAV.
 *
 * Each clip is trimmed to its span's slot length so the on-disk
 * playhead matches the span timestamps the inspector seeks by. If TTS
 * runs longer than the slot the tail is dropped; if shorter, the slot
 * pads with silence. Trimming (rather than expanding the buffer) keeps
 * playback aligned with `replay_turns.started_at`/`ended_at` — that
 * alignment is the whole reason this script uploads one mixdown
 * instead of N per-turn clips.
 */
async function synthesizeReplayWavViaOpenAI(apiKey: string): Promise<ArrayBuffer> {
	const sampleRate = TTS_SAMPLE_RATE;
	const totalSamples = Math.round(((PLAYED.at(-1)?.endMs ?? 0) / 1000) * sampleRate);
	const mix = new Int16Array(totalSamples);
	for (const seg of PLAYED) {
		const samples = await ttsToPcm(apiKey, seg.transcript, TTS_VOICE_FOR_ROLE[seg.role]);
		const startSamples = Math.round((seg.startMs / 1000) * sampleRate);
		const endSamples = Math.round((seg.endMs / 1000) * sampleRate);
		const slotLength = Math.max(0, endSamples - startSamples);
		const clipLength = Math.min(samples.length, slotLength, totalSamples - startSamples);
		if (clipLength > 0) mix.set(samples.subarray(0, clipLength), startSamples);
	}
	return wavFromPcm(mix, sampleRate);
}

async function ttsToPcm(apiKey: string, text: string, voice: string): Promise<Int16Array> {
	const res = await fetch("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: TTS_MODEL,
			voice,
			input: text,
			// PCM = raw 16-bit signed little-endian, 24 kHz mono. Trivial
			// to concatenate without an audio-decoding library.
			response_format: "pcm",
		}),
	});
	if (!res.ok) {
		throw new SeedRequestError(
			"POST",
			"https://api.openai.com/v1/audio/speech",
			res.status,
			res.statusText,
			await res.text(),
		);
	}
	const buf = await res.arrayBuffer();
	return new Int16Array(buf);
}

/**
 * Fallback when no OpenAI key is configured. Different sine frequency
 * per replay so the three runs sound different, with a per-segment
 * envelope so turn boundaries are audible.
 */
function synthesizeReplayWavViaSine(replayIdx: number): ArrayBuffer {
	const sampleRate = SINE_SAMPLE_RATE;
	const totalSamples = Math.round(((PLAYED.at(-1)?.endMs ?? 0) / 1000) * sampleRate);
	const mix = new Int16Array(totalSamples);
	const baseFreq = 220 + replayIdx * 110;
	for (const seg of PLAYED) {
		const start = Math.round((seg.startMs / 1000) * sampleRate);
		const end = Math.round((seg.endMs / 1000) * sampleRate);
		// User turns ride at baseFreq, agent turns up a fifth.
		const freq = seg.role === "user" ? baseFreq : baseFreq * 1.5;
		const amplitude = 0.25 * 0x7fff;
		for (let i = start; i < end && i < totalSamples; i++) {
			const sample = Math.round(
				amplitude * Math.sin((2 * Math.PI * freq * (i - start)) / sampleRate),
			);
			mix[i] = sample;
		}
	}
	return wavFromPcm(mix, sampleRate);
}

/**
 * Wrap raw 16-bit signed PCM samples (mono) in a minimal RIFF/WAV
 * container. No external dep — the format is small enough to spell out
 * by hand and the resulting file plays in every browser.
 */
function wavFromPcm(samples: Int16Array, sampleRate: number): ArrayBuffer {
	const bytesPerSample = 2;
	const dataBytes = samples.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);

	writeAscii(view, 0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(view, 8, "WAVE");
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM format
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * bytesPerSample, true);
	view.setUint16(32, bytesPerSample, true);
	view.setUint16(34, 16, true);
	writeAscii(view, 36, "data");
	view.setUint32(40, dataBytes, true);

	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i] ?? 0;
		view.setInt16(44 + i * bytesPerSample, sample, true);
	}
	return buffer;
}

function writeAscii(view: DataView, offset: number, ascii: string): void {
	for (let i = 0; i < ascii.length; i++) view.setUint8(offset + i, ascii.charCodeAt(i));
}

// --- otlp wire helpers ---

function kv(key: string, value: string | number | boolean) {
	if (typeof value === "string") return { key, value: { stringValue: value } };
	if (typeof value === "boolean") return { key, value: { boolValue: value } };
	if (Number.isInteger(value)) return { key, value: { intValue: String(value) } };
	return { key, value: { doubleValue: value } };
}

function span(opts: {
	name: string;
	start: number;
	end: number;
	attrs: Record<string, string | number | boolean>;
}) {
	return {
		traceId: randomHex(32),
		spanId: randomHex(16),
		name: opts.name,
		startTimeUnixNano: String(BigInt(opts.start) * 1_000_000n),
		endTimeUnixNano: String(BigInt(opts.end) * 1_000_000n),
		attributes: Object.entries(opts.attrs).map(([k, v2]) => kv(k, v2)),
	};
}

function randomHex(length: number): string {
	// crypto.randomUUID yields 32 hex chars; loop for the 16-char case rather
	// than slicing because the floating-point accumulator the previous
	// implementation used overflowed past 2^53 on long span names and
	// silently collided on (replay_id, span_id), tripping the spans
	// onConflictDoNothing path.
	let out = "";
	while (out.length < length) out += crypto.randomUUID().replace(/-/g, "");
	return out.slice(0, length);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
