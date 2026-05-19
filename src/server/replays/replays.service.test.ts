import { upsertConversation } from "@/server/conversations/conversations.service.ts";
import { makeConversationSpec } from "@/server/conversations/conversations.test-utils.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import {
	ConversationVersionNotFoundError,
	ReplayNotFoundError,
	ReplayStatusTransitionError,
} from "./replays.errors.ts";
import {
	compareReplays,
	createReplay,
	getReplay,
	listReplaysForConversation,
	updateReplay,
} from "./replays.service.ts";
import { makeCreateReplayRequest, seedReplay } from "./replays.test-utils.ts";
import { describe, expect, it } from "bun:test";

describe("createReplay", () => {
	it("creates a row with status='running' and modality default 'voice'", () => {
		const store = makeTempStore();
		upsertConversation(
			store,
			makeConversationSpec({ id: "c", version: "v1" }),
			() => "2026-05-18T11:00:00.000Z",
		);
		const detail = createReplay(
			store,
			makeCreateReplayRequest({ conversationId: "c", conversationVersion: "v1" }),
			{ now: () => "2026-05-18T12:00:00.000Z" },
		);
		expect(detail.status).toBe("running");
		expect(detail.modality).toBe("voice");
		expect(detail.startedAt).toBe("2026-05-18T12:00:00.000Z");
		expect(detail.judge.status).toBeNull();
		store.close();
	});

	it("rejects unknown (conversationId, conversationVersion)", () => {
		const store = makeTempStore();
		expect(() =>
			createReplay(
				store,
				makeCreateReplayRequest({ conversationId: "missing", conversationVersion: "v1" }),
			),
		).toThrow(ConversationVersionNotFoundError);
		store.close();
	});

	it("persists runConfig as JSON for later diff", () => {
		const store = makeTempStore();
		upsertConversation(store, makeConversationSpec({ id: "c", version: "v1" }));
		const detail = createReplay(
			store,
			makeCreateReplayRequest({
				conversationId: "c",
				conversationVersion: "v1",
				runConfig: { model: "gpt-4o", temperature: 0.5 },
			}),
		);
		expect(detail.runConfig).toEqual({ model: "gpt-4o", temperature: 0.5 });
		store.close();
	});
});

describe("updateReplay", () => {
	it("applies status + finishedAt + judge fields", () => {
		const store = makeTempStore();
		const id = seedReplay(store);
		const after = updateReplay(store, id, {
			status: "completed",
			finishedAt: "2026-05-18T12:05:00.000Z",
			judge: { status: "passed", score: 92, reason: "responded correctly" },
		});
		expect(after.status).toBe("completed");
		expect(after.finishedAt).toBe("2026-05-18T12:05:00.000Z");
		expect(after.judge.status).toBe("passed");
		expect(after.judge.score).toBe(92);
		store.close();
	});

	it("throws ReplayNotFoundError for unknown id", () => {
		const store = makeTempStore();
		expect(() =>
			updateReplay(store, "00000000-0000-0000-0000-000000000000", { status: "completed" }),
		).toThrow(ReplayNotFoundError);
		store.close();
	});

	it("ignores an empty patch", () => {
		const store = makeTempStore();
		const id = seedReplay(store);
		const before = getReplay(store, id);
		const after = updateReplay(store, id, {});
		expect(after).toEqual(before);
		store.close();
	});

	it("rejects status transitions out of 'failed' (terminal)", () => {
		const store = makeTempStore();
		const id = seedReplay(store);
		updateReplay(store, id, { status: "failed", failureReason: "agent_not_joined" });
		expect(() => updateReplay(store, id, { status: "completed" })).toThrow(
			ReplayStatusTransitionError,
		);
		// Same status (idempotent re-PATCH of the same terminal state) is allowed.
		expect(() => updateReplay(store, id, { status: "failed" })).not.toThrow();
		store.close();
	});
});

describe("getReplay / compareReplays / listReplaysForConversation", () => {
	it("getReplay throws ReplayNotFoundError for missing id", () => {
		const store = makeTempStore();
		expect(() => getReplay(store, "00000000-0000-0000-0000-000000000000")).toThrow(
			ReplayNotFoundError,
		);
		store.close();
	});

	it("compareReplays preserves request order", () => {
		const store = makeTempStore();
		const a = seedReplay(store, { id: "00000000-0000-0000-0000-00000000000a" });
		const b = seedReplay(store, { id: "00000000-0000-0000-0000-00000000000b" });
		const c = seedReplay(store, { id: "00000000-0000-0000-0000-00000000000c" });
		const res = compareReplays(store, [c, a, b]);
		expect(res.replays.map((r) => r.id)).toEqual([c, a, b]);
		store.close();
	});

	it("listReplaysForConversation returns newest-first summaries", () => {
		const store = makeTempStore();
		seedReplay(store, { conversationId: "c-list" });
		const id = seedReplay(store, { conversationId: "c-list" });
		updateReplay(store, id, { status: "completed", finishedAt: "2026-05-18T12:10:00.000Z" });
		const items = listReplaysForConversation(store, "c-list");
		expect(items).toHaveLength(2);
		const first = items[0]?.startedAt ?? "";
		const second = items[1]?.startedAt ?? "";
		expect(first >= second).toBe(true);
		store.close();
	});
});
