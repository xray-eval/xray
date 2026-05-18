import { makeTempStore } from "@/server/store/test-utils.ts";

import { VersionFingerprintMismatchError } from "./conversations.errors.ts";
import {
	canonicalizeTurns,
	getConversationVersion,
	getLatestConversation,
	listConversations,
	listConversationVersions,
	toConversationResponse,
	upsertConversation,
} from "./conversations.service.ts";
import { makeConversationSpec } from "./conversations.test-utils.ts";
import { describe, expect, it } from "bun:test";

describe("upsertConversation", () => {
	it("inserts a fresh row with the canonicalized turns json", () => {
		const store = makeTempStore();
		const spec = makeConversationSpec({ id: "conv-A", version: "v1" });
		const row = upsertConversation(store, spec, () => "2026-05-18T12:00:00.000Z");
		expect(row.id).toBe("conv-A");
		expect(row.version).toBe("v1");
		expect(row.turnsJson).toBe(canonicalizeTurns(spec.turns));
		expect(row.createdAt).toBe("2026-05-18T12:00:00.000Z");
		store.close();
	});

	it("re-upsert with byte-identical turns is idempotent", () => {
		const store = makeTempStore();
		const spec = makeConversationSpec({ id: "conv-B", version: "v1" });
		const first = upsertConversation(store, spec, () => "2026-05-18T12:00:00.000Z");
		const second = upsertConversation(store, spec, () => "2026-05-19T12:00:00.000Z");
		expect(second.createdAt).toBe(first.createdAt);
		expect(listConversationVersions(store, "conv-B")).toHaveLength(1);
		store.close();
	});

	it("re-upsert with different turn structure throws VersionFingerprintMismatchError", () => {
		const store = makeTempStore();
		const spec = makeConversationSpec({ id: "conv-C", version: "v1" });
		upsertConversation(store, spec);
		const drifted = makeConversationSpec({
			id: "conv-C",
			version: "v1",
			turns: [
				{ role: "user", text: "different content", key: "u0" },
				{ role: "agent", key: "a0" },
			],
		});
		expect(() => upsertConversation(store, drifted)).toThrow(VersionFingerprintMismatchError);
		store.close();
	});
});

describe("listConversations / getters", () => {
	it("aggregates one row per id, newest first", () => {
		const store = makeTempStore();
		upsertConversation(
			store,
			makeConversationSpec({ id: "a", version: "v1" }),
			() => "2026-05-10T00:00:00.000Z",
		);
		upsertConversation(
			store,
			makeConversationSpec({ id: "a", version: "v2" }),
			() => "2026-05-11T00:00:00.000Z",
		);
		upsertConversation(
			store,
			makeConversationSpec({ id: "b", version: "v1" }),
			() => "2026-05-12T00:00:00.000Z",
		);
		const summaries = listConversations(store);
		expect(summaries.map((s) => s.id)).toEqual(["b", "a"]);
		const a = summaries.find((s) => s.id === "a");
		expect(a?.versions).toBe(2);
		expect(a?.latestVersion).toBe("v2");
		store.close();
	});

	it("getLatestConversation returns the highest-createdAt version", () => {
		const store = makeTempStore();
		upsertConversation(
			store,
			makeConversationSpec({ id: "x", version: "v1" }),
			() => "2026-05-10T00:00:00.000Z",
		);
		upsertConversation(
			store,
			makeConversationSpec({ id: "x", version: "v2" }),
			() => "2026-05-11T00:00:00.000Z",
		);
		const latest = getLatestConversation(store, "x");
		expect(latest?.version).toBe("v2");
		store.close();
	});

	it("getConversationVersion returns the exact (id, version)", () => {
		const store = makeTempStore();
		upsertConversation(store, makeConversationSpec({ id: "x", version: "v1" }));
		expect(getConversationVersion(store, "x", "v1")?.version).toBe("v1");
		expect(getConversationVersion(store, "x", "missing")).toBeUndefined();
		store.close();
	});
});

describe("toConversationResponse", () => {
	it("re-parses turnsJson back to the spec shape", () => {
		const store = makeTempStore();
		const spec = makeConversationSpec({ id: "x", version: "v1" });
		const row = upsertConversation(store, spec);
		const response = toConversationResponse(row);
		expect(response.turns).toEqual(spec.turns);
		store.close();
	});
});
