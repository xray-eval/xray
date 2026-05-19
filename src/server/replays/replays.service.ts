import { desc, eq } from "drizzle-orm";

import { getConversationVersion } from "@/server/conversations/conversations.service.ts";
import {
	assertions,
	modelUsage,
	replayMeta,
	replays,
	replayTurns,
	spans,
	toolCalls,
} from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import type {
	AssertionRow,
	ModelUsageRow,
	ReplayMetaRow,
	ReplayRow,
	ReplayTurnRow,
	SpanRow,
	ToolCallRow,
} from "@/server/store/types.ts";

import {
	ConversationVersionNotFoundError,
	ReplayNotFoundError,
	ReplayStatusTransitionError,
} from "./replays.errors.ts";
import type {
	AssertionResponse,
	CompareReplaysResponse,
	CreateReplayRequest,
	ModelUsageResponse,
	ReplayDetailResponse,
	ReplaySummaryResponse,
	ReplayTurnResponse,
	SpanResponse,
	ToolCallResponse,
	UpdateReplayRequest,
} from "./replays.types.ts";

/**
 * Create a Replay row (and its sibling `replay_meta` row) eagerly. The SDK
 * calls this BEFORE joining the LiveKit room, so the returned `id` can be
 * propagated as OTEL baggage on the room metadata — any subsequent spans
 * the dev's agent emits route correctly via `xray.replay.id`.
 *
 * Throws `ConversationVersionNotFoundError` if the referenced conversation
 * doesn't exist — the trust boundary lives here, not in the OTLP receiver.
 */
export interface CreateReplayOptions {
	now?: () => string;
	id?: string;
}
export function createReplay(
	store: Store,
	req: CreateReplayRequest,
	opts: CreateReplayOptions = {},
): ReplayDetailResponse {
	const now = opts.now ?? (() => new Date().toISOString());
	const conv = getConversationVersion(store, req.conversationId, req.conversationVersion);
	if (conv === undefined) {
		throw new ConversationVersionNotFoundError(req.conversationId, req.conversationVersion);
	}
	const id = opts.id ?? crypto.randomUUID();
	const startedAt = now();
	const replayRow: ReplayRow = {
		id,
		conversationId: req.conversationId,
		conversationVersion: req.conversationVersion,
		status: "running",
		failureReason: null,
		startedAt,
		finishedAt: null,
		audioPath: null,
		transcript: null,
	};
	const metaRow: ReplayMetaRow = {
		replayId: id,
		modality: req.modality ?? "voice",
		runConfigJson: req.runConfig === undefined ? null : JSON.stringify(req.runConfig),
		judgeStatus: null,
		judgeScore: null,
		judgeReason: null,
		judgeError: null,
	};
	store.db.transaction((tx) => {
		tx.insert(replays).values(replayRow).run();
		tx.insert(replayMeta).values(metaRow).run();
	});
	return buildReplayDetail(store, id);
}

/**
 * Apply a PATCH body to a replay. Each field is treated as opt-in. Status
 * transitions out of `failed` are rejected because the SDK is the sole
 * writer and a failed run is terminal — a follow-up PATCH that "rescues"
 * a failed row would mask whatever flagged it.
 */
export function updateReplay(
	store: Store,
	id: string,
	patch: UpdateReplayRequest,
): ReplayDetailResponse {
	const existing = store.db.select().from(replays).where(eq(replays.id, id)).get();
	if (existing === undefined) throw new ReplayNotFoundError(id);
	if (existing.status === "failed" && patch.status !== undefined && patch.status !== "failed") {
		throw new ReplayStatusTransitionError(id, existing.status, patch.status);
	}

	store.db.transaction((tx) => {
		const replayUpdates: Partial<ReplayRow> = {};
		if (patch.status !== undefined) replayUpdates.status = patch.status;
		if (patch.failureReason !== undefined) replayUpdates.failureReason = patch.failureReason;
		if (patch.finishedAt !== undefined) replayUpdates.finishedAt = patch.finishedAt;
		if (patch.audioPath !== undefined) replayUpdates.audioPath = patch.audioPath;
		if (patch.transcript !== undefined) replayUpdates.transcript = patch.transcript;
		if (Object.keys(replayUpdates).length > 0) {
			tx.update(replays).set(replayUpdates).where(eq(replays.id, id)).run();
		}

		const metaUpdates: Partial<ReplayMetaRow> = {};
		if (patch.runConfig !== undefined) {
			metaUpdates.runConfigJson = patch.runConfig === null ? null : JSON.stringify(patch.runConfig);
		}
		if (patch.judge !== undefined) {
			metaUpdates.judgeStatus = patch.judge.status;
			metaUpdates.judgeScore = patch.judge.score ?? null;
			metaUpdates.judgeReason = patch.judge.reason ?? null;
			metaUpdates.judgeError = patch.judge.error ?? null;
		}
		if (Object.keys(metaUpdates).length > 0) {
			tx.update(replayMeta).set(metaUpdates).where(eq(replayMeta.replayId, id)).run();
		}
	});
	return buildReplayDetail(store, id);
}

export function getReplay(store: Store, id: string): ReplayDetailResponse {
	const replayRow = store.db.select().from(replays).where(eq(replays.id, id)).get();
	if (replayRow === undefined) throw new ReplayNotFoundError(id);
	return buildReplayDetail(store, id);
}

export function compareReplays(store: Store, ids: readonly string[]): CompareReplaysResponse {
	// Preserve caller-supplied order so the UI columns line up left-to-right
	// the way the user picked them.
	const out: ReplayDetailResponse[] = [];
	for (const id of ids) {
		const row = store.db.select().from(replays).where(eq(replays.id, id)).get();
		if (row === undefined) throw new ReplayNotFoundError(id);
		out.push(buildReplayDetail(store, id));
	}
	return { replays: out };
}

/**
 * Summary rows for the per-Conversation "Replays" list. Aggregates the
 * 1:1 `replay_meta` join so the UI doesn't fan out into N follow-up calls.
 */
export function listReplaysForConversation(
	store: Store,
	conversationId: string,
): ReplaySummaryResponse[] {
	const rows = store.db
		.select({ r: replays, m: replayMeta })
		.from(replays)
		.leftJoin(replayMeta, eq(replays.id, replayMeta.replayId))
		.where(eq(replays.conversationId, conversationId))
		.orderBy(desc(replays.startedAt))
		.all();
	return rows.map(({ r, m }) => toSummary(r, m));
}

function toSummary(r: ReplayRow, m: ReplayMetaRow | null): ReplaySummaryResponse {
	return {
		id: r.id,
		conversationId: r.conversationId,
		conversationVersion: r.conversationVersion,
		status: r.status,
		failureReason: r.failureReason,
		modality: m?.modality ?? "voice",
		startedAt: r.startedAt,
		finishedAt: r.finishedAt,
		judgeStatus: m?.judgeStatus ?? null,
		judgeScore: m?.judgeScore ?? null,
		runConfig: parseJsonOrNull(m?.runConfigJson ?? null),
	};
}

function buildReplayDetail(store: Store, id: string): ReplayDetailResponse {
	const r = store.db.select().from(replays).where(eq(replays.id, id)).get();
	if (r === undefined) throw new ReplayNotFoundError(id);
	const m = store.db.select().from(replayMeta).where(eq(replayMeta.replayId, id)).get();
	const turns = store.db.select().from(replayTurns).where(eq(replayTurns.replayId, id)).all();
	turns.sort((a, b) => a.idx - b.idx);
	const assertionRows = store.db.select().from(assertions).where(eq(assertions.replayId, id)).all();
	assertionRows.sort((a, b) => a.turnIdx - b.turnIdx || (a.id ?? 0) - (b.id ?? 0));
	const toolCallRows = store.db.select().from(toolCalls).where(eq(toolCalls.replayId, id)).all();
	const modelUsageRows = store.db
		.select()
		.from(modelUsage)
		.where(eq(modelUsage.replayId, id))
		.all();
	const spanRows = store.db.select().from(spans).where(eq(spans.replayId, id)).all();
	spanRows.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
	return {
		id: r.id,
		conversationId: r.conversationId,
		conversationVersion: r.conversationVersion,
		status: r.status,
		failureReason: r.failureReason,
		modality: m?.modality ?? "voice",
		startedAt: r.startedAt,
		finishedAt: r.finishedAt,
		audioPath: r.audioPath,
		transcript: r.transcript,
		runConfig: parseJsonOrNull(m?.runConfigJson ?? null),
		judge: {
			status: m?.judgeStatus ?? null,
			score: m?.judgeScore ?? null,
			reason: m?.judgeReason ?? null,
			error: m?.judgeError ?? null,
		},
		turns: turns.map(toTurnResponse),
		assertions: assertionRows.map(toAssertionResponse),
		toolCalls: toolCallRows.map(toToolCallResponse),
		modelUsage: modelUsageRows.map(toModelUsageResponse),
		spans: spanRows.map(toSpanResponse),
	};
}

function toTurnResponse(row: ReplayTurnRow): ReplayTurnResponse {
	return {
		idx: row.idx,
		role: row.role,
		key: row.key,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		transcript: row.transcript,
		audioPath: row.audioPath,
	};
}

function toAssertionResponse(row: AssertionRow): AssertionResponse {
	return {
		id: row.id,
		turnIdx: row.turnIdx,
		name: row.name,
		status: row.status,
		message: row.message,
		recordedAt: row.recordedAt,
	};
}

function toToolCallResponse(row: ToolCallRow): ToolCallResponse {
	return {
		id: row.id,
		turnIdx: row.turnIdx,
		spanId: row.spanId,
		name: row.name,
		argsJson: row.argsJson,
		resultJson: row.resultJson,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		latencyMs: row.latencyMs,
	};
}

function toModelUsageResponse(row: ModelUsageRow): ModelUsageResponse {
	return {
		id: row.id,
		turnIdx: row.turnIdx,
		spanId: row.spanId,
		provider: row.provider,
		model: row.model,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		totalTokens: row.totalTokens,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		latencyMs: row.latencyMs,
	};
}

function toSpanResponse(row: SpanRow): SpanResponse {
	return {
		id: row.id,
		traceId: row.traceId,
		spanId: row.spanId,
		parentSpanId: row.parentSpanId,
		name: row.name,
		vocabulary: row.vocabulary,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		attributesJson: row.attributesJson,
	};
}

function parseJsonOrNull(raw: string | null): unknown {
	if (raw === null) return null;
	try {
		return JSON.parse(raw);
	} catch {
		// A corrupt run_config_json shouldn't 500 the whole get; the inspector
		// already handles `runConfig === null` as the empty case.
		return null;
	}
}

/** Convenience: look up a replay-by-id without crafting a full detail. */
export function findReplay(store: Store, id: string): ReplayRow | undefined {
	return store.db.select().from(replays).where(eq(replays.id, id)).get();
}

/** Used by the OTLP receiver to assert a replay_id is real before persisting. */
export function replayExists(store: Store, id: string): boolean {
	return findReplay(store, id) !== undefined;
}
