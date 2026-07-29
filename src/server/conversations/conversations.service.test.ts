import * as v from "valibot";

import type { Judge } from "@/server/judges/judges.types.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { TtsTurnMissingTextError, TtsTurnRoleError } from "./conversations.errors.ts";
import {
	canonicalizeAndHashSpec,
	canonicalStringify,
	ensureConversation,
	getConversationByHash,
	getConversationSpec,
	listConversations,
	materializeRequestTurns,
	toConversationResponse,
} from "./conversations.service.ts";
import { makeTurns } from "./conversations.test-utils.ts";
import type { ConversationTurn } from "./conversations.types.ts";
import { ConversationTurnSchema, CreateConversationRequestSchema } from "./conversations.types.ts";
import { describe, expect, it } from "bun:test";

function fakeSynthesizer(): {
	synthesize: (input: {
		text: string;
		voiceId?: string;
		language?: string;
	}) => Promise<{ sha256: string }>;
	calls: { text: string; voiceId?: string; language?: string }[];
} {
	const calls: { text: string; voiceId?: string; language?: string }[] = [];
	return {
		calls,
		async synthesize(input) {
			calls.push(input);
			const tag = `${input.text}|${input.voiceId ?? ""}|${input.language ?? ""}`;
			const hex = [...new TextEncoder().encode(tag)]
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			return { sha256: hex.padEnd(64, "0").slice(0, 64) };
		},
	};
}

async function hashOf(
	turns: readonly ConversationTurn[],
	judges: readonly Judge[] = [],
): Promise<string> {
	return (await canonicalizeAndHashSpec(turns, judges)).hash;
}
async function canonicalize(
	turns: readonly ConversationTurn[],
	judges: readonly Judge[] = [],
): Promise<string> {
	return (await canonicalizeAndHashSpec(turns, judges)).json;
}

describe("ensureConversation", () => {
	it("inserts a fresh row on missing hash", async () => {
		const store = makeTempStore();
		const turns = makeTurns();
		const hash = await hashOf(turns);
		const row = ensureConversation(store.db, {
			hash,
			name: "My conversation",
			turnsJson: await canonicalize(turns),
			now: "2026-05-18T12:00:00.000Z",
		});
		expect(row.hash).toBe(hash);
		expect(row.name).toBe("My conversation");
		expect(row.createdAt).toBe("2026-05-18T12:00:00.000Z");
		expect(row.lastRunAt).toBe("2026-05-18T12:00:00.000Z");
		store.close();
	});

	it("on existing hash: last-write-wins on name, bumps last_run_at", async () => {
		const store = makeTempStore();
		const turns = makeTurns();
		const hash = await hashOf(turns);
		ensureConversation(store.db, {
			hash,
			name: "First",
			turnsJson: await canonicalize(turns),
			now: "2026-05-18T12:00:00.000Z",
		});
		const second = ensureConversation(store.db, {
			hash,
			name: "Second",
			turnsJson: await canonicalize(turns),
			now: "2026-05-19T12:00:00.000Z",
		});
		expect(second.name).toBe("Second");
		const row = getConversationByHash(store, hash);
		expect(row?.name).toBe("Second");
		expect(row?.lastRunAt).toBe("2026-05-19T12:00:00.000Z");
		expect(row?.createdAt).toBe("2026-05-18T12:00:00.000Z");
		store.close();
	});
});

describe("listConversations", () => {
	it("returns one row per hash, ordered by last_run_at desc", async () => {
		const store = makeTempStore();
		const turnsA = makeTurns({
			turns: [
				{ role: "user", text: "alpha", key: "u0" },
				{ role: "agent", key: "a0" },
			],
		});
		const turnsB = makeTurns({
			turns: [
				{ role: "user", text: "beta", key: "u0" },
				{ role: "agent", key: "a0" },
			],
		});
		const hashA = await hashOf(turnsA);
		const hashB = await hashOf(turnsB);
		ensureConversation(store.db, {
			hash: hashA,
			name: "A",
			turnsJson: await canonicalize(turnsA),
			now: "2026-05-10T00:00:00.000Z",
		});
		ensureConversation(store.db, {
			hash: hashB,
			name: "B",
			turnsJson: await canonicalize(turnsB),
			now: "2026-05-12T00:00:00.000Z",
		});
		const summaries = listConversations(store);
		expect(summaries.map((s) => s.name)).toEqual(["B", "A"]);
		expect(summaries.every((s) => s.replays === 0)).toBe(true);
		store.close();
	});
});

describe("toConversationResponse", () => {
	it("re-parses turnsJson back to the spec shape", async () => {
		const store = makeTempStore();
		const turns = makeTurns();
		const hash = await hashOf(turns);
		const row = ensureConversation(store.db, {
			hash,
			name: "My conversation",
			turnsJson: await canonicalize(turns),
			now: "2026-05-18T12:00:00.000Z",
		});
		const response = toConversationResponse(row);
		expect(response.turns).toEqual(turns);
		expect(response.name).toBe("My conversation");
		expect(response.hash).toBe(hash);
		store.close();
	});

	it("returns empty turns and warns when turnsJson is unparseable", () => {
		const warn = console.warn;
		const calls: unknown[][] = [];
		console.warn = (...args: unknown[]) => {
			calls.push(args);
		};
		try {
			const response = toConversationResponse({
				hash: "deadbeef".repeat(8),
				name: "corrupt row",
				turnsJson: "{not valid json",
				createdAt: "2026-05-18T12:00:00.000Z",
				lastRunAt: null,
			});
			expect(response.turns).toEqual([]);
			expect(calls.length).toBe(1);
			expect(String(calls[0]?.[0])).toContain("JSON.parse failed");
		} finally {
			console.warn = warn;
		}
	});

	it("returns empty turns and warns when turnsJson fails schema validation", () => {
		const warn = console.warn;
		const calls: unknown[][] = [];
		console.warn = (...args: unknown[]) => {
			calls.push(args);
		};
		try {
			const response = toConversationResponse({
				hash: "cafebabe".repeat(8),
				name: "shape drift",
				turnsJson: JSON.stringify([{ role: "user", text: 42 }]),
				createdAt: "2026-05-18T12:00:00.000Z",
				lastRunAt: null,
			});
			expect(response.turns).toEqual([]);
			expect(calls.length).toBe(1);
			expect(String(calls[0]?.[0])).toContain("schema validation failed");
		} finally {
			console.warn = warn;
		}
	});
});

describe("canonicalizeAndHashSpec", () => {
	it("is deterministic for the same spec", async () => {
		const turns = makeTurns();
		const a = await hashOf(turns);
		const b = await hashOf(turns);
		expect(a).toBe(b);
		expect(a).toHaveLength(64);
	});

	it("changes when turn text changes", async () => {
		const a = await hashOf(
			makeTurns({
				turns: [
					{ role: "user", text: "alpha", key: "u0" },
					{ role: "agent", key: "a0" },
				],
			}),
		);
		const b = await hashOf(
			makeTurns({
				turns: [
					{ role: "user", text: "beta", key: "u0" },
					{ role: "agent", key: "a0" },
				],
			}),
		);
		expect(a).not.toBe(b);
	});

	it("changes when an assertion is added to a turn", async () => {
		const baseTurns = makeTurns({
			turns: [
				{ role: "user", text: "hi", key: "u0" },
				{ role: "agent", key: "a0" },
			],
		});
		const withAssertion = makeTurns({
			turns: [
				{ role: "user", text: "hi", key: "u0" },
				{
					role: "agent",
					key: "a0",
					assertions: [{ kind: "contains", text: "hello", case_insensitive: true }],
				},
			],
		});
		const a = await hashOf(baseTurns);
		const b = await hashOf(withAssertion);
		expect(a).not.toBe(b);
	});

	it("changes when a conversation-level judge is added", async () => {
		const turns = makeTurns();
		const a = await hashOf(turns, []);
		const b = await hashOf(turns, [
			{ kind: "text_match", reference: "agent confirms booking", pass_score: 70 },
		]);
		expect(a).not.toBe(b);
	});

	it("accepts integer numbers (assertion params like max_ms) round-trip in the hash", async () => {
		const turnsLow = makeTurns({
			turns: [
				{ role: "user", text: "hi", key: "u0" },
				{
					role: "agent",
					key: "a0",
					assertions: [{ kind: "max_latency_ms", max_ms: 1000 }],
				},
			],
		});
		const turnsHigh = makeTurns({
			turns: [
				{ role: "user", text: "hi", key: "u0" },
				{
					role: "agent",
					key: "a0",
					assertions: [{ kind: "max_latency_ms", max_ms: 2000 }],
				},
			],
		});
		const a = await hashOf(turnsLow);
		const b = await hashOf(turnsHigh);
		expect(a).not.toBe(b);
	});

	it("rejects non-integer numeric values in the canonical input", () => {
		expect(() => canonicalStringify({ x: 1.5 })).toThrow(/non-integer number/);
		expect(() => canonicalStringify({ nested: { deep: [{ x: 0.1 }] } })).toThrow(
			/non-integer number/,
		);
	});

	it("rejects NaN / Infinity", () => {
		expect(() => canonicalStringify({ x: Number.NaN })).toThrow(/NaN/);
		expect(() => canonicalStringify({ x: Number.POSITIVE_INFINITY })).toThrow(/NaN/);
	});

	it("normalizes -0 to 0", () => {
		expect(canonicalStringify({ a: -0 })).toBe(canonicalStringify({ a: 0 }));
	});

	it("accepts booleans (true/false roundtrip cleanly)", () => {
		expect(() =>
			canonicalStringify([{ role: "user", text: "hi", key: "u0", flag: true }]),
		).not.toThrow();
	});
});

describe("interrupt_after_ms", () => {
	it("leaves the hash of a conversation that doesn't use it untouched", async () => {
		const turns = makeTurns({
			turns: [
				{ role: "user", text: "hi", key: "u0" },
				{ role: "agent", key: "a0" },
			],
		});
		const json = await canonicalize(turns);
		expect(json).not.toContain("interrupt_after_ms");
	});

	it("changes the hash when a turn barges in", async () => {
		const base = makeTurns({
			turns: [
				{ role: "agent", key: "a0" },
				{ role: "user", text: "no, Berlin", key: "u0" },
			],
		});
		const withInterrupt = makeTurns({
			turns: [
				{ role: "agent", key: "a0" },
				{ role: "user", text: "no, Berlin", key: "u0", interrupt_after_ms: 2000 },
			],
		});
		expect(await hashOf(base)).not.toBe(await hashOf(withInterrupt));
		expect(await canonicalize(withInterrupt)).toContain('"interrupt_after_ms":2000');
	});

	it("round-trips through the canonical turn schema, absent when unset", () => {
		const withField = v.parse(ConversationTurnSchema, {
			role: "user",
			text: "no, Berlin",
			interrupt_after_ms: 2000,
		});
		expect(withField.interrupt_after_ms).toBe(2000);

		const withoutField = v.parse(ConversationTurnSchema, { role: "user", text: "hi" });
		expect(withoutField).not.toHaveProperty("interrupt_after_ms");
	});

	it("accepts a user turn that immediately follows an agent turn", () => {
		const result = v.safeParse(CreateConversationRequestSchema, {
			name: "barge-in",
			turns: [
				{ role: "user", text: "book a flight to Paris" },
				{ role: "agent" },
				{ role: "user", text: "no, Berlin", interrupt_after_ms: 2000 },
				{ role: "agent" },
			],
		});
		expect(result.success).toBe(true);
	});

	it("rejects it on an agent turn, on a non-following user turn, and on the first turn", () => {
		const onAgentTurn = v.safeParse(CreateConversationRequestSchema, {
			name: "bad",
			turns: [
				{ role: "user", text: "hi" },
				{ role: "agent", interrupt_after_ms: 2000 },
			],
		});
		expect(onAgentTurn.success).toBe(false);

		const notFollowingAgent = v.safeParse(CreateConversationRequestSchema, {
			name: "bad",
			turns: [
				{ role: "user", text: "hi" },
				{ role: "user", text: "no, Berlin", interrupt_after_ms: 2000 },
			],
		});
		expect(notFollowingAgent.success).toBe(false);

		const firstTurn = v.safeParse(CreateConversationRequestSchema, {
			name: "bad",
			turns: [{ role: "user", text: "no, Berlin", interrupt_after_ms: 2000 }],
		});
		expect(firstTurn.success).toBe(false);
	});

	it("rejects a zero or fractional delay at the schema", () => {
		const zero = v.safeParse(ConversationTurnSchema, {
			role: "user",
			text: "x",
			interrupt_after_ms: 0,
		});
		expect(zero.success).toBe(false);

		const fractional = v.safeParse(ConversationTurnSchema, {
			role: "user",
			text: "x",
			interrupt_after_ms: 1.5,
		});
		expect(fractional.success).toBe(false);
	});
});

describe("quiet_period_ms", () => {
	it("leaves the hash of a conversation that doesn't use it untouched", async () => {
		const turns = makeTurns({
			turns: [
				{ role: "user", text: "hi", key: "u0" },
				{ role: "agent", key: "a0" },
			],
		});
		expect(await canonicalize(turns)).not.toContain("quiet_period_ms");
	});

	it("changes the hash when a turn declares one", async () => {
		const base = makeTurns({ turns: [{ role: "agent", key: "a0" }] });
		const withQuiet = makeTurns({
			turns: [{ role: "agent", key: "a0", quiet_period_ms: 8000 }],
		});
		expect(await hashOf(base)).not.toBe(await hashOf(withQuiet));
		expect(await canonicalize(withQuiet)).toContain('"quiet_period_ms":8000');
	});

	it("accepts it on an agent turn and rejects it on a user turn", () => {
		const onAgent = v.safeParse(CreateConversationRequestSchema, {
			name: "narrate-then-tool",
			turns: [
				{ role: "user", text: "what year is it?" },
				{ role: "agent", quiet_period_ms: 8000 },
			],
		});
		expect(onAgent.success).toBe(true);

		const onUser = v.safeParse(CreateConversationRequestSchema, {
			name: "bad",
			turns: [{ role: "user", text: "hi", quiet_period_ms: 8000 }],
		});
		expect(onUser.success).toBe(false);
	});

	it("rejects a zero or fractional period at the schema", () => {
		expect(v.safeParse(ConversationTurnSchema, { role: "agent", quiet_period_ms: 0 }).success).toBe(
			false,
		);
		expect(
			v.safeParse(ConversationTurnSchema, { role: "agent", quiet_period_ms: 1.5 }).success,
		).toBe(false);
	});
});

describe("live conversations", () => {
	it("salts the hash so two empty-turn live specs are distinct rows", async () => {
		const a = await canonicalizeAndHashSpec([], [], true);
		const b = await canonicalizeAndHashSpec([], [], true);
		expect(a.hash).toHaveLength(64);
		expect(a.hash).not.toBe(b.hash);
		expect(a.json).toContain('"live":true');
		expect(a.json).toContain('"live_salt":');
	});

	it("a live empty spec hashes differently from a non-live empty spec", async () => {
		const live = await canonicalizeAndHashSpec([], [], true);
		const nonLive = await canonicalizeAndHashSpec([], [], false);
		expect(live.hash).not.toBe(nonLive.hash);
		expect(nonLive.json).not.toContain("live");
	});

	it("round-trips live=true + empty turns through storage", async () => {
		const store = makeTempStore();
		const { json, hash } = await canonicalizeAndHashSpec([], [], true);
		const row = ensureConversation(store.db, {
			hash,
			name: "live-2026-05-26T00:00:00Z",
			turnsJson: json,
			now: "2026-05-26T00:00:00.000Z",
		});
		const response = toConversationResponse(row);
		expect(response.live).toBe(true);
		expect(response.turns).toEqual([]);

		const spec = getConversationSpec(store, hash);
		expect(spec?.live).toBe(true);
		expect(spec?.turns).toEqual([]);
		store.close();
	});

	it("a scripted conversation reads back live=false", async () => {
		const store = makeTempStore();
		const turns = makeTurns();
		const { json, hash } = await canonicalizeAndHashSpec(turns, []);
		const row = ensureConversation(store.db, {
			hash,
			name: "scripted",
			turnsJson: json,
			now: "2026-05-26T00:00:00.000Z",
		});
		expect(toConversationResponse(row).live).toBe(false);
		expect(getConversationSpec(store, hash)?.live).toBe(false);
		store.close();
	});
});

describe("materializeRequestTurns", () => {
	it("substitutes audio bytes sha256 into the canonical RecordedAudio turn", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		const map = new Map<string, Uint8Array<ArrayBuffer>>([["audio_0", bytes]]);
		const { canonicalTurns, audioWrites } = await materializeRequestTurns(
			[
				{
					role: "user",
					text: "hi",
					audio: { kind: "recorded", upload_key: "audio_0" },
					assertions: [],
				},
				{ role: "agent", assertions: [] },
			],
			map,
			fakeSynthesizer().synthesize,
		);
		expect(audioWrites).toHaveLength(1);
		const sha = audioWrites[0]?.sha256 ?? "";
		expect(sha).toHaveLength(64);
		expect(audioWrites[0]?.bytes).toBe(bytes);
		const userTurn = canonicalTurns[0];
		expect(userTurn?.audio).toEqual({ kind: "recorded", sha256: sha });
	});

	it("throws if a RecordedAudio turn references an upload_key with no matching bytes", async () => {
		await expect(
			materializeRequestTurns(
				[
					{
						role: "user",
						text: "hi",
						audio: { kind: "recorded", upload_key: "audio_0" },
						assertions: [],
					},
				],
				new Map(),
				fakeSynthesizer().synthesize,
			),
		).rejects.toThrow(/upload_key/);
	});

	it("throws if a multipart part is uploaded that no turn references", async () => {
		await expect(
			materializeRequestTurns(
				[{ role: "user", text: "hi", assertions: [] }],
				new Map<string, Uint8Array<ArrayBuffer>>([["orphan", new Uint8Array([0])]]),
				fakeSynthesizer().synthesize,
			),
		).rejects.toThrow(/orphan/);
	});

	it("synthesizes TTS turns and substitutes the generated audio sha into the canonical form", async () => {
		const synth = fakeSynthesizer();
		const { canonicalTurns } = await materializeRequestTurns(
			[
				{
					role: "user",
					text: "hi",
					audio: { kind: "tts", voice_id: "nova" },
					assertions: [],
				},
				{ role: "agent", assertions: [] },
			],
			new Map(),
			synth.synthesize,
		);
		expect(synth.calls).toEqual([{ text: "hi", voiceId: "nova" }]);
		const audio = canonicalTurns[0]?.audio;
		if (audio?.kind !== "tts") throw new Error(`expected tts audio, got ${JSON.stringify(audio)}`);
		expect(audio.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(audio.voice_id).toBe("nova");
		expect(canonicalTurns[1]?.audio).toBeUndefined();
	});

	it("omits voice_id and language from the canonical tts ref when the spec didn't set them", async () => {
		const synth = fakeSynthesizer();
		const { canonicalTurns } = await materializeRequestTurns(
			[{ role: "user", text: "hi", audio: { kind: "tts" }, assertions: [] }],
			new Map(),
			synth.synthesize,
		);
		expect(synth.calls).toEqual([{ text: "hi" }]);
		const audio = canonicalTurns[0]?.audio;
		if (audio?.kind !== "tts") throw new Error("expected tts audio");
		expect("voice_id" in audio).toBe(false);
		expect("language" in audio).toBe(false);
	});

	it("forwards the turn language to the synthesizer and keeps it on the canonical tts ref", async () => {
		const synth = fakeSynthesizer();
		const { canonicalTurns } = await materializeRequestTurns(
			[
				{
					role: "user",
					text: "guten tag",
					audio: { kind: "tts", language: "de" },
					assertions: [],
				},
			],
			new Map(),
			synth.synthesize,
		);
		expect(synth.calls).toEqual([{ text: "guten tag", language: "de" }]);
		const audio = canonicalTurns[0]?.audio;
		if (audio?.kind !== "tts") throw new Error("expected tts audio");
		expect(audio.language).toBe("de");
	});

	it("rejects a malformed turn language at the request schema", () => {
		const result = v.safeParse(CreateConversationRequestSchema, {
			name: "t",
			turns: [{ role: "user", text: "x", audio: { kind: "tts", language: "German" } }],
		});
		expect(result.success).toBe(false);
	});

	it("throws TtsTurnMissingTextError for a tts turn without text", async () => {
		await expect(
			materializeRequestTurns(
				[{ role: "user", audio: { kind: "tts" }, assertions: [] }],
				new Map(),
				fakeSynthesizer().synthesize,
			),
		).rejects.toBeInstanceOf(TtsTurnMissingTextError);
	});

	it("throws TtsTurnRoleError for a tts audio ref on an agent turn", async () => {
		await expect(
			materializeRequestTurns(
				[{ role: "agent", text: "x", audio: { kind: "tts" }, assertions: [] }],
				new Map(),
				fakeSynthesizer().synthesize,
			),
		).rejects.toBeInstanceOf(TtsTurnRoleError);
	});

	it("validates every tts turn up front — a later invalid turn bills no earlier synthesis", async () => {
		const synth = fakeSynthesizer();
		await expect(
			materializeRequestTurns(
				[
					{ role: "user", text: "first", audio: { kind: "tts" }, assertions: [] },
					{ role: "user", audio: { kind: "tts" }, assertions: [] },
				],
				new Map(),
				synth.synthesize,
			),
		).rejects.toBeInstanceOf(TtsTurnMissingTextError);
		expect(synth.calls).toEqual([]);
	});

	it("cancels in-flight tts synthesis when a sibling synthesis fails", async () => {
		let firstSignal: AbortSignal | undefined;
		const synth = (input: { text: string }, signal?: AbortSignal): Promise<{ sha256: string }> => {
			if (input.text === "boom") return Promise.reject(new Error("provider boom"));
			firstSignal = signal;
			const { promise, reject } = Promise.withResolvers<{ sha256: string }>();
			signal?.addEventListener("abort", () => reject(new Error("cancelled")));
			return promise;
		};
		await expect(
			materializeRequestTurns(
				[
					{ role: "user", text: "slow", audio: { kind: "tts" }, assertions: [] },
					{ role: "user", text: "boom", audio: { kind: "tts" }, assertions: [] },
				],
				new Map(),
				synth,
			),
		).rejects.toThrow();
		expect(firstSignal?.aborted).toBe(true);
	});
});
