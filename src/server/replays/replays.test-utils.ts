import { conversations, replays } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";

import type { CreateReplayRequest, UpdateReplayRequest } from "./replays.types.ts";

let counter = 0;

export function makeCreateReplayRequest(
	overrides: Partial<CreateReplayRequest> = {},
): CreateReplayRequest {
	return {
		conversation_id: "conv-1",
		conversation_version: "v0001",
		...overrides,
	};
}

export function makeUpdateReplayRequest(
	overrides: Partial<UpdateReplayRequest> = {},
): UpdateReplayRequest {
	return {
		lifecycle_state: "running",
		...overrides,
	};
}

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
			lifecycleState: "pending",
			analysisStep: null,
			failureReason: null,
			startedAt: "2026-05-18T12:00:00.000Z",
			finishedAt: null,
			audioPath: null,
			runConfigJson: null,
			jobId: null,
		})
		.run();
	return id;
}
