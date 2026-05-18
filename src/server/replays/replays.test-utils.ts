import { conversations, replayMeta, replays } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";

import type { CreateReplayRequest, UpdateReplayRequest } from "./replays.types.ts";

let counter = 0;

export function makeCreateReplayRequest(
	overrides: Partial<CreateReplayRequest> = {},
): CreateReplayRequest {
	return {
		conversationId: "conv-1",
		conversationVersion: "v0001",
		modality: "voice",
		...overrides,
	};
}

export function makeUpdateReplayRequest(
	overrides: Partial<UpdateReplayRequest> = {},
): UpdateReplayRequest {
	return {
		status: "completed",
		finishedAt: "2026-05-18T12:00:01.000Z",
		...overrides,
	};
}

/**
 * Insert a (conversation, replay, replay_meta) trio directly into a test
 * store — useful for tests of the patch / get / compare endpoints that
 * don't care about the create-replay flow.
 */
export function seedReplay(
	store: Store,
	overrides: { conversationId?: string; conversationVersion?: string; id?: string } = {},
): string {
	counter += 1;
	const conversationId = overrides.conversationId ?? "conv-1";
	const conversationVersion = overrides.conversationVersion ?? "v0001";
	const id = overrides.id ?? `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`;
	store.db
		.insert(conversations)
		.values({
			id: conversationId,
			version: conversationVersion,
			turnsJson: "[]",
			title: null,
			createdAt: "2026-05-18T11:00:00.000Z",
		})
		.onConflictDoNothing()
		.run();
	store.db
		.insert(replays)
		.values({
			id,
			conversationId,
			conversationVersion,
			status: "running",
			failureReason: null,
			startedAt: "2026-05-18T12:00:00.000Z",
			finishedAt: null,
			audioPath: null,
			transcript: null,
		})
		.run();
	store.db
		.insert(replayMeta)
		.values({
			replayId: id,
			modality: "voice",
			runConfigJson: null,
			judgeStatus: null,
			judgeScore: null,
			judgeReason: null,
			judgeError: null,
		})
		.run();
	return id;
}
