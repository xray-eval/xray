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
	const conv = getConversationVersion(store, req.conversation_id, req.conversation_version);
	if (conv === undefined) {
		throw new ConversationVersionNotFoundError(req.conversation_id, req.conversation_version);
	}
	const id = opts.id ?? crypto.randomUUID();
	const startedAt = now();
	const replayRow: ReplayRow = {
		id,
		conversationId: req.conversation_id,
		conversationVersion: req.conversation_version,
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
		runConfigJson: req.run_config === undefined ? null : JSON.stringify(req.run_config),
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
		if (patch.failure_reason !== undefined) replayUpdates.failureReason = patch.failure_reason;
		if (patch.finished_at !== undefined) replayUpdates.finishedAt = patch.finished_at;
		if (patch.audio_path !== undefined) replayUpdates.audioPath = patch.audio_path;
		if (patch.transcript !== undefined) replayUpdates.transcript = patch.transcript;
		if (Object.keys(replayUpdates).length > 0) {
			tx.update(replays).set(replayUpdates).where(eq(replays.id, id)).run();
		}

		const metaUpdates: Partial<ReplayMetaRow> = {};
		if (patch.run_config !== undefined) {
			metaUpdates.runConfigJson =
				patch.run_config === null ? null : JSON.stringify(patch.run_config);
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
		conversation_id: r.conversationId,
		conversation_version: r.conversationVersion,
		status: r.status,
		failure_reason: r.failureReason,
		modality: m?.modality ?? "voice",
		started_at: r.startedAt,
		finished_at: r.finishedAt,
		judge_status: m?.judgeStatus ?? null,
		judge_score: m?.judgeScore ?? null,
		run_config: parseJsonOrNull(m?.runConfigJson ?? null),
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
		conversation_id: r.conversationId,
		conversation_version: r.conversationVersion,
		status: r.status,
		failure_reason: r.failureReason,
		modality: m?.modality ?? "voice",
		started_at: r.startedAt,
		finished_at: r.finishedAt,
		audio_path: r.audioPath,
		transcript: r.transcript,
		run_config: parseJsonOrNull(m?.runConfigJson ?? null),
		judge: {
			status: m?.judgeStatus ?? null,
			score: m?.judgeScore ?? null,
			reason: m?.judgeReason ?? null,
			error: m?.judgeError ?? null,
		},
		turns: turns.map(toTurnResponse),
		assertions: assertionRows.map(toAssertionResponse),
		tool_calls: toolCallRows.map(toToolCallResponse),
		model_usage: modelUsageRows.map(toModelUsageResponse),
		spans: spanRows.map(toSpanResponse),
	};
}

function toTurnResponse(row: ReplayTurnRow): ReplayTurnResponse {
	return {
		idx: row.idx,
		role: row.role,
		key: row.key,
		started_at: row.startedAt,
		ended_at: row.endedAt,
		transcript: row.transcript,
		audio_path: row.audioPath,
	};
}

function toAssertionResponse(row: AssertionRow): AssertionResponse {
	return {
		id: row.id,
		turn_idx: row.turnIdx,
		name: row.name,
		status: row.status,
		message: row.message,
		recorded_at: row.recordedAt,
	};
}

function toToolCallResponse(row: ToolCallRow): ToolCallResponse {
	return {
		id: row.id,
		turn_idx: row.turnIdx,
		span_id: row.spanId,
		name: row.name,
		args_json: row.argsJson,
		result_json: row.resultJson,
		started_at: row.startedAt,
		ended_at: row.endedAt,
		latency_ms: row.latencyMs,
	};
}

function toModelUsageResponse(row: ModelUsageRow): ModelUsageResponse {
	return {
		id: row.id,
		turn_idx: row.turnIdx,
		span_id: row.spanId,
		provider: row.provider,
		model: row.model,
		input_tokens: row.inputTokens,
		output_tokens: row.outputTokens,
		total_tokens: row.totalTokens,
		started_at: row.startedAt,
		ended_at: row.endedAt,
		latency_ms: row.latencyMs,
	};
}

function toSpanResponse(row: SpanRow): SpanResponse {
	return {
		id: row.id,
		trace_id: row.traceId,
		span_id: row.spanId,
		parent_span_id: row.parentSpanId,
		name: row.name,
		vocabulary: row.vocabulary,
		started_at: row.startedAt,
		ended_at: row.endedAt,
		attributes_json: row.attributesJson,
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
