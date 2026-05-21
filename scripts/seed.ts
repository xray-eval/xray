// Seed the running xray dev server so the UI has something to render
// without a real LiveKit-Python agent loop.
//
// Posts one Conversation via POST /v1/conversations (multipart with the
// canonical `spec` JSON), then N Replays via POST /v1/replays referencing
// the returned conversation hash. For each Replay it pushes a small
// synthetic OTLP/JSON batch with a mix of vocabularies (xray.assertion,
// xray.judge, xray.turn, gen_ai.chat, gen_ai.execute_tool, langfuse
// generation), uploads a 48kHz int16 stereo WAV (user on left, agent on
// right) so the analyze worker can derive `replay_turns` +
// `speech_segments`, and either kicks off the analyze job (→ completed)
// or PATCHes the row to `failed`.
//
// Usage:
//   pnpm dev                              # in one terminal
//   pnpm seed                             # in another — falls back to sine
//   OPENAI_API_KEY=sk-... pnpm seed       # synthesizes real TTS for each turn
//
// Override target via env: XRAY_BASE_URL=http://otherhost:9000 pnpm seed

import * as v from "valibot";

import type { UpdateReplayRequest } from "@/server/replays/replays.types.ts";

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

class SeedShapeError extends SeedError {
	readonly path: string;
	readonly issues: readonly v.BaseIssue<unknown>[];
	constructor(path: string, issues: readonly v.BaseIssue<unknown>[]) {
		super(`${path}: schema mismatch — ${issues.map((i) => i.message).join("; ")}`);
		this.name = "SeedShapeError";
		this.path = path;
		this.issues = issues;
	}
}

function parseOrThrow<S extends v.GenericSchema>(
	path: string,
	schema: S,
	value: unknown,
): v.InferOutput<S> {
	const result = v.safeParse(schema, value);
	if (!result.success) throw new SeedShapeError(path, result.issues);
	return result.output;
}

const EnvSchema = v.object({
	XRAY_BASE_URL: v.optional(v.string()),
	OPENAI_API_KEY: v.optional(v.string()),
	OPENAI_TTS_MODEL: v.optional(v.string()),
});
const ENV = parseOrThrow("process.env", EnvSchema, process.env);
const BASE = ENV.XRAY_BASE_URL ?? "http://localhost:8080";
const TTS_MODEL = ENV.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";

interface SeedTurn {
	role: "user" | "agent";
	text: string;
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

const CONVERSATION_NAME = "Books a table for two — happy path";
const REPLAY_COUNT = 3;

const TURNS: SeedTurn[] = [
	{ role: "user", text: "Hi, I'd like to book a table for two at 7pm.", key: "u0" },
	{ role: "agent", text: "Confirmed — two at 7pm. Anything else I can help with?", key: "a0" },
	{ role: "user", text: "Anything else I should know?", key: "u1" },
	{
		role: "agent",
		text: "We hold reservations for 15 minutes past your time — see you then.",
		key: "a1",
	},
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
	const conversationHash = await postConversation();
	for (let i = 0; i < REPLAY_COUNT; i++) {
		const replayId = await postReplay(conversationHash, i);
		await pushOtlp(replayId, i);
		await uploadReplayAudio(replayId, i);
		if (i === REPLAY_COUNT - 1) {
			await patchReplayFailed(replayId, i);
		} else {
			await analyzeReplay(replayId);
		}
	}
	console.info(
		`seeded ${REPLAY_COUNT} replays under conversation ${conversationHash.slice(0, 12)}…`,
	);
}

async function postConversation(): Promise<string> {
	const spec = { name: CONVERSATION_NAME, turns: TURNS };
	const form = new FormData();
	// `spec` is a string form field (server reads it via `typeof value === "string"`).
	// Passing a Blob would land it as a File part and the server would drop it.
	form.set("spec", JSON.stringify(spec));
	const res = await fetch(`${BASE}/v1/conversations`, { method: "POST", body: form });
	if (!res.ok) {
		throw new SeedRequestError(
			"POST",
			"/v1/conversations",
			res.status,
			res.statusText,
			await res.text(),
		);
	}
	const parsed = parseOrThrow(
		"POST /v1/conversations response",
		v.object({ hash: v.string() }),
		await res.json(),
	);
	return parsed.hash;
}

async function postReplay(conversationHash: string, idx: number): Promise<string> {
	const body = {
		conversation_hash: conversationHash,
		run_config: {
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
	const parsed = parseOrThrow(
		"POST /v1/replays response",
		v.object({ id: v.string() }),
		await res.json(),
	);
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
					attributes: [kv("xray.replay.id", replayId), kv("xray.modality", "voice")],
				},
				scopeSpans: [
					{
						scope: { name: "seed", attributes: [] },
						spans: [
							// xray.turn spans — one per played segment. Server-derived
							// `replay_turns` (from VAD) are the ground truth; these spans
							// are still recognized as the `xray` vocabulary and surface in
							// the raw-spans table.
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

// 48kHz int16 stereo WAV per replay — user voice on left channel, agent on
// right, silence on the other channel during the opposing role's turn. The
// analyze worker VADs each channel independently to derive `replay_turns`
// and `speech_segments`; the channel layout is what makes role inference
// possible without any side-channel.
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

async function analyzeReplay(replayId: string) {
	const res = await fetch(`${BASE}/v1/replays/${replayId}/analyze`, { method: "POST" });
	if (!res.ok) {
		throw new SeedRequestError(
			"POST",
			`/v1/replays/${replayId}/analyze`,
			res.status,
			res.statusText,
			await res.text(),
		);
	}
}

async function patchReplayFailed(replayId: string, idx: number) {
	const body: UpdateReplayRequest = {
		lifecycle_state: "failed",
		failure_reason: "driver_aborted",
		finished_at: new Date(Date.UTC(2026, 4, 18 + idx, 12, 0, 15)).toISOString(),
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

const WAV_SAMPLE_RATE = 48_000; // server requires 48kHz int16 stereo.
const TTS_SAMPLE_RATE = 24_000; // OpenAI TTS PCM is fixed at 24 kHz mono.

/**
 * TTS each segment, drop it on the matching stereo channel (user→left,
 * agent→right) of a single 48 kHz int16 mixdown.
 *
 * The OpenAI endpoint returns 24 kHz mono PCM; we upsample 2× by linear
 * interpolation. Each clip is trimmed to its span's slot length so the
 * on-disk playhead matches the span timestamps the inspector seeks by.
 */
async function synthesizeReplayWavViaOpenAI(apiKey: string): Promise<ArrayBuffer> {
	const totalSamples = Math.round(((PLAYED.at(-1)?.endMs ?? 0) / 1000) * WAV_SAMPLE_RATE);
	const left = new Int16Array(totalSamples);
	const right = new Int16Array(totalSamples);
	for (const seg of PLAYED) {
		const ttsPcm = await ttsToPcm(apiKey, seg.transcript, TTS_VOICE_FOR_ROLE[seg.role]);
		const samples = upsamplePcm(ttsPcm, TTS_SAMPLE_RATE, WAV_SAMPLE_RATE);
		const startSamples = Math.round((seg.startMs / 1000) * WAV_SAMPLE_RATE);
		const endSamples = Math.round((seg.endMs / 1000) * WAV_SAMPLE_RATE);
		const slotLength = Math.max(0, endSamples - startSamples);
		const clipLength = Math.min(samples.length, slotLength, totalSamples - startSamples);
		if (clipLength <= 0) continue;
		const channel = seg.role === "user" ? left : right;
		channel.set(samples.subarray(0, clipLength), startSamples);
	}
	return wavFromStereoPcm(left, right, WAV_SAMPLE_RATE);
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
 * Fallback when no OpenAI key is configured. Stereo: user tone rides the
 * left channel during user turns, agent tone rides the right channel
 * during agent turns. Different base frequency per replay so the three
 * runs sound different. The opposing channel stays silent during a turn
 * so the analyze worker's per-channel VAD sees clean alternating energy.
 */
function synthesizeReplayWavViaSine(replayIdx: number): ArrayBuffer {
	const sampleRate = WAV_SAMPLE_RATE;
	const totalSamples = Math.round(((PLAYED.at(-1)?.endMs ?? 0) / 1000) * sampleRate);
	const left = new Int16Array(totalSamples);
	const right = new Int16Array(totalSamples);
	const baseFreq = 220 + replayIdx * 110;
	for (const seg of PLAYED) {
		const start = Math.round((seg.startMs / 1000) * sampleRate);
		const end = Math.round((seg.endMs / 1000) * sampleRate);
		const freq = seg.role === "user" ? baseFreq : baseFreq * 1.5;
		const amplitude = 0.25 * 0x7fff;
		const channel = seg.role === "user" ? left : right;
		for (let i = start; i < end && i < totalSamples; i++) {
			const sample = Math.round(
				amplitude * Math.sin((2 * Math.PI * freq * (i - start)) / sampleRate),
			);
			channel[i] = sample;
		}
	}
	return wavFromStereoPcm(left, right, sampleRate);
}

/**
 * Linear-interpolation upsample from `srcRate` to `dstRate`. Mirrors the
 * server-side downsampler — fidelity is irrelevant for seed audio; we just
 * need a 48 kHz buffer the server's stereo WAV reader accepts.
 */
function upsamplePcm(pcm: Int16Array, srcRate: number, dstRate: number): Int16Array {
	if (srcRate === dstRate) return pcm;
	const ratio = srcRate / dstRate;
	const outLength = Math.floor((pcm.length * dstRate) / srcRate);
	const out = new Int16Array(outLength);
	for (let i = 0; i < outLength; i++) {
		const src = i * ratio;
		const i0 = Math.floor(src);
		const i1 = Math.min(i0 + 1, pcm.length - 1);
		const t = src - i0;
		const s0 = pcm[i0] ?? 0;
		const s1 = pcm[i1] ?? 0;
		out[i] = Math.round(s0 + (s1 - s0) * t);
	}
	return out;
}

/**
 * Wrap two equal-length int16 channels in a minimal 48 kHz stereo RIFF/WAV
 * container. Format matches what the server's `readStereoWav` expects:
 * PCM, 2 channels, 16 bits per sample, 48 kHz.
 */
function wavFromStereoPcm(left: Int16Array, right: Int16Array, sampleRate: number): ArrayBuffer {
	if (left.length !== right.length) {
		throw new SeedError(
			`stereo channels must have equal length (left=${left.length} right=${right.length})`,
		);
	}
	const channels = 2;
	const bitsPerSample = 16;
	const bytesPerSample = bitsPerSample / 8;
	const dataBytes = left.length * channels * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);

	writeAscii(view, 0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(view, 8, "WAVE");
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM format
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * bytesPerSample, true);
	view.setUint16(32, channels * bytesPerSample, true);
	view.setUint16(34, bitsPerSample, true);
	writeAscii(view, 36, "data");
	view.setUint32(40, dataBytes, true);

	for (let i = 0; i < left.length; i++) {
		const offset = 44 + i * channels * bytesPerSample;
		view.setInt16(offset, left[i] ?? 0, true);
		view.setInt16(offset + bytesPerSample, right[i] ?? 0, true);
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
