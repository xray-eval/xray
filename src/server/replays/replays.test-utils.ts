import { makeTurns, seedConversation } from "@/server/conversations/conversations.test-utils.ts";
import type { ConversationTurn } from "@/server/conversations/conversations.types.ts";
import { replays } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";

import { createReplay } from "./replays.service.ts";
import type { ReplayDetailResponse, UpdateReplayRequest } from "./replays.types.ts";

let counter = 0;

export interface CreateReplayTestOverrides {
	name?: string;
	turns?: ConversationTurn[];
	conversation_hash?: string;
	run_config?: unknown;
}

/**
 * Build the create-replay request shape used by tests. Pure data —
 * doesn't touch the store. If `conversation_hash` is not provided, the
 * helper hashes a deterministic seed turn array; callers pass the hash to
 * `seedConversation` (or `createReplayForTest`) to actually persist the row.
 */
export function makeCreateReplayRequest(overrides: CreateReplayTestOverrides = {}): {
	conversation_hash: string;
	name: string;
	turns: ConversationTurn[];
	run_config?: unknown;
} {
	counter += 1;
	const turns = overrides.turns ?? makeTurns();
	const name = overrides.name ?? `Conversation ${counter}`;
	return {
		conversation_hash: overrides.conversation_hash ?? "",
		name,
		turns,
		...(overrides.run_config !== undefined ? { run_config: overrides.run_config } : {}),
	};
}

/**
 * Seed a conversation row keyed by the canonical turn hash and create a
 * replay against it. Returns the freshly-created replay's detail row.
 * Tests pass a partial request (name/turns/run_config) — the helper
 * hashes the turns, upserts the conversation row, and forwards the hash
 * to `createReplay`.
 */
export async function createReplayForTest(
	store: Store,
	req: CreateReplayTestOverrides | ReturnType<typeof makeCreateReplayRequest> = {},
): Promise<ReplayDetailResponse> {
	const filled = isAlreadyFilled(req) ? req : makeCreateReplayRequest(req);
	const { hash } = await seedConversation(store, { name: filled.name, turns: filled.turns });
	return createReplay(store, {
		conversation_hash: hash,
		...(filled.run_config !== undefined ? { run_config: filled.run_config } : {}),
	});
}

function isAlreadyFilled(
	req: CreateReplayTestOverrides | ReturnType<typeof makeCreateReplayRequest>,
): req is ReturnType<typeof makeCreateReplayRequest> {
	if (!("conversation_hash" in req && "name" in req && "turns" in req)) return false;
	const { turns } = req;
	return Array.isArray(turns);
}

export function makeUpdateReplayRequest(
	overrides: Partial<UpdateReplayRequest> = {},
): UpdateReplayRequest {
	return {
		lifecycle_state: "running",
		...overrides,
	};
}

/**
 * Insert a (conversation, replay) pair directly into a test store — used by
 * patch / get / compare endpoint tests that don't care about the
 * create-replay flow.
 */
export async function seedReplay(
	store: Store,
	overrides: {
		name?: string;
		turns?: ConversationTurn[];
		conversationHash?: string;
		id?: string;
	} = {},
): Promise<{ replayId: string; conversationHash: string }> {
	counter += 1;
	const turnsOpts: { turns?: ConversationTurn[] } = {};
	if (overrides.turns !== undefined) turnsOpts.turns = overrides.turns;
	const turns = makeTurns(turnsOpts);
	const name = overrides.name ?? `Conversation ${counter}`;
	const { hash: derivedHash } = await seedConversation(store, {
		name,
		turns,
		lastRunAt: "2026-05-18T12:00:00.000Z",
	});
	const conversationHash = overrides.conversationHash ?? derivedHash;
	const id = overrides.id ?? `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`;
	store.db
		.insert(replays)
		.values({
			id,
			conversationHash,
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
	return { replayId: id, conversationHash };
}
