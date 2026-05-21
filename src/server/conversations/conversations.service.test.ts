import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as v from "valibot";

import { makeTempStore } from "@/server/store/test-utils.ts";

import {
	canonicalizeAndHashTurns,
	canonicalizeTurns,
	computeConversationHash,
	ensureConversation,
	getConversationByHash,
	listConversations,
	toConversationResponse,
} from "./conversations.service.ts";
import { makeTurns } from "./conversations.test-utils.ts";
import { ConversationTurnSchema } from "./conversations.types.ts";
import { describe, expect, it } from "bun:test";

describe("ensureConversation", () => {
	it("inserts a fresh row on missing hash", async () => {
		const store = makeTempStore();
		const turns = makeTurns();
		const hash = await computeConversationHash(turns);
		const row = ensureConversation(
			store.db,
			hash,
			"My conversation",
			canonicalizeTurns(turns),
			"2026-05-18T12:00:00.000Z",
		);
		expect(row.hash).toBe(hash);
		expect(row.name).toBe("My conversation");
		expect(row.createdAt).toBe("2026-05-18T12:00:00.000Z");
		expect(row.lastRunAt).toBe("2026-05-18T12:00:00.000Z");
		store.close();
	});

	it("on existing hash: last-write-wins on name, bumps last_run_at", async () => {
		const store = makeTempStore();
		const turns = makeTurns();
		const hash = await computeConversationHash(turns);
		ensureConversation(
			store.db,
			hash,
			"First",
			canonicalizeTurns(turns),
			"2026-05-18T12:00:00.000Z",
		);
		const second = ensureConversation(
			store.db,
			hash,
			"Second",
			canonicalizeTurns(turns),
			"2026-05-19T12:00:00.000Z",
		);
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
		const hashA = await computeConversationHash(turnsA);
		const hashB = await computeConversationHash(turnsB);
		ensureConversation(store.db, hashA, "A", canonicalizeTurns(turnsA), "2026-05-10T00:00:00.000Z");
		ensureConversation(store.db, hashB, "B", canonicalizeTurns(turnsB), "2026-05-12T00:00:00.000Z");
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
		const hash = await computeConversationHash(turns);
		const row = ensureConversation(
			store.db,
			hash,
			"My conversation",
			canonicalizeTurns(turns),
			"2026-05-18T12:00:00.000Z",
		);
		const response = toConversationResponse(row);
		expect(response.turns).toEqual(turns);
		expect(response.name).toBe("My conversation");
		expect(response.hash).toBe(hash);
		store.close();
	});
});

describe("computeConversationHash", () => {
	it("is deterministic for the same turns", async () => {
		const turns = makeTurns();
		const a = await computeConversationHash(turns);
		const b = await computeConversationHash(turns);
		expect(a).toBe(b);
		expect(a).toHaveLength(64);
	});

	it("changes when turn text changes", async () => {
		const a = await computeConversationHash(
			makeTurns({
				turns: [
					{ role: "user", text: "alpha", key: "u0" },
					{ role: "agent", key: "a0" },
				],
			}),
		);
		const b = await computeConversationHash(
			makeTurns({
				turns: [
					{ role: "user", text: "beta", key: "u0" },
					{ role: "agent", key: "a0" },
				],
			}),
		);
		expect(a).not.toBe(b);
	});

	it("matches every case in the cross-language parity fixture", async () => {
		const ParityCaseSchema = v.object({
			name: v.string(),
			description: v.string(),
			turns_wire: v.array(ConversationTurnSchema),
			canonical_json: v.string(),
			expected_hash: v.string(),
		});
		const ParityFixtureSchema = v.object({
			description: v.string(),
			cases: v.array(ParityCaseSchema),
		});
		const raw = JSON.parse(
			readFileSync(
				join(__dirname, "..", "..", "..", "tests", "fixtures", "hash-parity.json"),
				"utf-8",
			),
		);
		const fixture = v.parse(ParityFixtureSchema, raw);
		expect(fixture.cases.length).toBeGreaterThan(1);
		for (const c of fixture.cases) {
			const { json, hash } = await canonicalizeAndHashTurns(c.turns_wire);
			expect(json, `case ${c.name}: canonical_json`).toBe(c.canonical_json);
			expect(hash, `case ${c.name}: expected_hash`).toBe(c.expected_hash);
		}
	});
});
