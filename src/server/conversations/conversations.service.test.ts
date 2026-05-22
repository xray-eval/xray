import { makeTempStore } from "@/server/store/test-utils.ts";

import {
	canonicalizeAndHashTurns,
	canonicalStringify,
	ensureConversation,
	getConversationByHash,
	listConversations,
	materializeRequestTurns,
	toConversationResponse,
} from "./conversations.service.ts";
import { makeTurns } from "./conversations.test-utils.ts";
import { describe, expect, it } from "bun:test";

async function hashOf(turns: Parameters<typeof canonicalizeAndHashTurns>[0]): Promise<string> {
	return (await canonicalizeAndHashTurns(turns)).hash;
}
async function canonicalize(
	turns: Parameters<typeof canonicalizeAndHashTurns>[0],
): Promise<string> {
	return (await canonicalizeAndHashTurns(turns)).json;
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
		// createdAt is the original; only name + last_run_at update.
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

describe("canonicalizeAndHashTurns", () => {
	it("is deterministic for the same turns", async () => {
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

	it("rejects numeric values in the canonical input", () => {
		expect(() => canonicalStringify([{ role: "user", text: "hi", key: "u0", score: 1 }])).toThrow(
			/Cannot canonicalize a number/,
		);
		expect(() =>
			canonicalStringify([{ role: "user", text: "hi", key: "u0", nested: { deep: [{ x: 1.5 }] } }]),
		).toThrow(/Cannot canonicalize a number/);
	});

	it("accepts booleans (true/false roundtrip cleanly)", () => {
		expect(() =>
			canonicalStringify([{ role: "user", text: "hi", key: "u0", flag: true }]),
		).not.toThrow();
	});
});

describe("materializeRequestTurns", () => {
	it("substitutes audio bytes sha256 into the canonical RecordedAudio turn", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		const map = new Map<string, Uint8Array<ArrayBuffer>>([["audio_0", bytes]]);
		const { canonicalTurns, audioWrites } = await materializeRequestTurns(
			[
				{ role: "user", text: "hi", audio: { kind: "recorded", upload_key: "audio_0" } },
				{ role: "agent" },
			],
			map,
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
				[{ role: "user", text: "hi", audio: { kind: "recorded", upload_key: "audio_0" } }],
				new Map(),
			),
		).rejects.toThrow(/upload_key/);
	});

	it("throws if a multipart part is uploaded that no turn references", async () => {
		await expect(
			materializeRequestTurns(
				[{ role: "user", text: "hi" }],
				new Map<string, Uint8Array<ArrayBuffer>>([["orphan", new Uint8Array([0])]]),
			),
		).rejects.toThrow(/orphan/);
	});

	it("passes through TTS audio turns unchanged", async () => {
		const { canonicalTurns } = await materializeRequestTurns(
			[{ role: "user", text: "hi", audio: { kind: "tts", voice_id: "nova" } }, { role: "agent" }],
			new Map(),
		);
		expect(canonicalTurns[0]?.audio).toEqual({ kind: "tts", voice_id: "nova" });
	});
});
