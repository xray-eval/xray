import { and, desc, eq } from "drizzle-orm";

import { ConversationNotFoundError } from "@/server/conversations/conversations.errors.ts";
import { getConversationByHash } from "@/server/conversations/conversations.service.ts";
import type { JobRunner } from "@/server/jobs/jobs.bunqueue.ts";
import {
	modelUsage,
	replays,
	replayTurns,
	spans,
	speechSegments,
	toolCalls,
} from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import type {
	ModelUsageRow,
	ReplayFailureReason,
	ReplayLifecycleState,
	ReplayRow,
	ReplayTurnRow,
	SpanRow,
	SpeechSegmentRow,
	ToolCallRow,
} from "@/server/store/types.ts";

import {
	ReplayLifecycleTransitionError,
	ReplayNotFoundError,
	ReplayNotReadyForAnalysisError,
} from "./replays.errors.ts";
import type { ReplayEvents } from "./replays.events.ts";
import type {
	CompareReplaysResponse,
	CreateReplayRequest,
	ModelUsageResponse,
	ReplayDetailResponse,
	ReplaySummaryResponse,
	ReplayTurnResponse,
	SpanResponse,
	SpeechSegmentResponse,
	ToolCallResponse,
	UpdateReplayRequest,
} from "./replays.types.ts";

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
	const conv = getConversationByHash(store, req.conversation_hash);
	if (conv === undefined) {
		throw new ConversationNotFoundError(req.conversation_hash);
	}
	const id = opts.id ?? crypto.randomUUID();
	const startedAt = now();
	const replayRow: ReplayRow = {
		id,
		conversationHash: req.conversation_hash,
		lifecycleState: "pending",
		analysisStep: null,
		failureReason: null,
		startedAt,
		finishedAt: null,
		audioPath: null,
		runConfigJson: req.run_config === undefined ? null : JSON.stringify(req.run_config),
		jobId: null,
	};
	store.db.insert(replays).values(replayRow).run();
	return buildReplayDetail(store, replayRow);
}

const TERMINAL_STATES = new Set<ReplayLifecycleState>(["completed", "failed"]);

export function updateReplay(
	store: Store,
	id: string,
	patch: UpdateReplayRequest,
): ReplayDetailResponse {
	const existing = store.db.select().from(replays).where(eq(replays.id, id)).get();
	if (existing === undefined) throw new ReplayNotFoundError(id);
	if (patch.lifecycle_state !== undefined) {
		if (
			TERMINAL_STATES.has(existing.lifecycleState) &&
			patch.lifecycle_state !== existing.lifecycleState
		) {
			throw new ReplayLifecycleTransitionError(id, existing.lifecycleState, patch.lifecycle_state);
		}
		// The bunqueue worker owns the `analyzing` lifecycle. An API PATCH must
		// not mutate state out from under it — the worker's terminal `completed`
		// write is guarded against a stale `analyzing` claim, but blocking the
		// PATCH at the boundary keeps the invariant crisp + surfaces 409 to the
		// caller instead of a silent overwrite race.
		if (
			existing.lifecycleState === "analyzing" &&
			patch.lifecycle_state !== existing.lifecycleState
		) {
			throw new ReplayLifecycleTransitionError(id, existing.lifecycleState, patch.lifecycle_state);
		}
	}

	const updates: Partial<ReplayRow> = {};
	if (patch.lifecycle_state !== undefined) updates.lifecycleState = patch.lifecycle_state;
	if (patch.failure_reason !== undefined) updates.failureReason = patch.failure_reason;
	if (patch.finished_at !== undefined) updates.finishedAt = patch.finished_at;
	let row: ReplayRow = existing;
	if (Object.keys(updates).length > 0) {
		store.db.update(replays).set(updates).where(eq(replays.id, id)).run();
		row = { ...existing, ...updates };
	}
	return buildReplayDetail(store, row);
}

export function getReplay(store: Store, id: string): ReplayDetailResponse {
	const replayRow = store.db.select().from(replays).where(eq(replays.id, id)).get();
	if (replayRow === undefined) throw new ReplayNotFoundError(id);
	return buildReplayDetail(store, replayRow);
}

export function compareReplays(store: Store, ids: readonly string[]): CompareReplaysResponse {
	const out: ReplayDetailResponse[] = [];
	for (const id of ids) {
		const row = store.db.select().from(replays).where(eq(replays.id, id)).get();
		if (row === undefined) throw new ReplayNotFoundError(id);
		out.push(buildReplayDetail(store, row));
	}
	return { replays: out };
}

export function listReplaysForConversation(
	store: Store,
	conversationHash: string,
): ReplaySummaryResponse[] {
	const rows = store.db
		.select()
		.from(replays)
		.where(eq(replays.conversationHash, conversationHash))
		.orderBy(desc(replays.startedAt))
		.all();
	return rows.map(toSummary);
}

function toSummary(r: ReplayRow): ReplaySummaryResponse {
	return {
		id: r.id,
		conversation_hash: r.conversationHash,
		lifecycle_state: r.lifecycleState,
		analysis_step: r.analysisStep,
		failure_reason: r.failureReason,
		started_at: r.startedAt,
		finished_at: r.finishedAt,
		run_config: parseJsonOrNull(r.runConfigJson),
	};
}

function buildReplayDetail(store: Store, r: ReplayRow): ReplayDetailResponse {
	const id = r.id;
	const turns = store.db.select().from(replayTurns).where(eq(replayTurns.replayId, id)).all();
	turns.sort((a, b) => a.idx - b.idx);
	const segments = store.db
		.select()
		.from(speechSegments)
		.where(eq(speechSegments.replayId, id))
		.all();
	segments.sort((a, b) => a.startMs - b.startMs);
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
		conversation_hash: r.conversationHash,
		lifecycle_state: r.lifecycleState,
		analysis_step: r.analysisStep,
		failure_reason: r.failureReason,
		started_at: r.startedAt,
		finished_at: r.finishedAt,
		audio_path: r.audioPath,
		job_id: r.jobId,
		run_config: parseJsonOrNull(r.runConfigJson),
		turns: turns.map(toTurnResponse),
		speech_segments: segments.map(toSegmentResponse),
		tool_calls: toolCallRows.map(toToolCallResponse),
		model_usage: modelUsageRows.map(toModelUsageResponse),
		spans: spanRows.map(toSpanResponse),
	};
}

function toTurnResponse(row: ReplayTurnRow): ReplayTurnResponse {
	return {
		idx: row.idx,
		role: row.role,
		turn_start_ms: row.turnStartMs,
		turn_end_ms: row.turnEndMs,
		voice_start_ms: row.voiceStartMs,
		voice_end_ms: row.voiceEndMs,
	};
}

function toSegmentResponse(row: SpeechSegmentRow): SpeechSegmentResponse {
	return {
		id: row.id,
		channel: row.channel,
		start_ms: row.startMs,
		end_ms: row.endMs,
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
		return null;
	}
}

export function findReplay(store: Store, id: string): ReplayRow | undefined {
	return store.db.select().from(replays).where(eq(replays.id, id)).get();
}

export function replayExists(store: Store, id: string): boolean {
	return findReplay(store, id) !== undefined;
}

export interface MarkReplayFailedOptions {
	now?: () => string;
}

/**
 * Stamp a replay's row with `lifecycle_state='failed'` + reason + cleared
 * `analysis_step` + `finished_at`, then emit the matching SSE events.
 *
 * Idempotent and terminal-safe: if the row is already in a terminal state
 * (`completed` or `failed`), this is a no-op — no DB write, no SSE emit. That
 * matters because bunqueue's `failed` event can fire more than once across a
 * job's retry lifecycle, and a terminal `completed` row must not be unwound
 * by a stray late failure.
 *
 * Silent on a missing row — the bunqueue onFailed callback must not throw on
 * a replay whose row vanished (e.g. operator wiped /data mid-flight).
 */
export function markReplayFailed(
	store: Store,
	events: ReplayEvents,
	replayId: string,
	reason: ReplayFailureReason,
	opts: MarkReplayFailedOptions = {},
): void {
	const existing = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
	if (existing === undefined) return;
	if (existing.lifecycleState === "completed" || existing.lifecycleState === "failed") return;
	const now = opts.now ?? (() => new Date().toISOString());
	store.db
		.update(replays)
		.set({
			lifecycleState: "failed",
			failureReason: reason,
			analysisStep: null,
			finishedAt: now(),
		})
		.where(eq(replays.id, replayId))
		.run();
	events.emit(replayId, { type: "failed", reason });
	events.emit(replayId, { type: "state", lifecycle_state: "failed", analysis_step: null });
}

/**
 * POST /v1/replays/:id/analyze handler. Atomically claims the analyzing
 * lifecycle for this replay before enqueuing, so two concurrent /analyze
 * calls for the same id can't both schedule bunqueue jobs.
 */
export async function enqueueAnalysis(
	store: Store,
	jobRunner: JobRunner,
	events: ReplayEvents,
	id: string,
): Promise<{ jobId: string; lifecycleState: "analyzing" }> {
	const replay = findReplay(store, id);
	if (replay === undefined) throw new ReplayNotFoundError(id);
	if (replay.lifecycleState !== "recording_uploaded") {
		throw new ReplayNotReadyForAnalysisError(id, replay.lifecycleState);
	}

	store.db
		.update(replays)
		.set({ lifecycleState: "analyzing", analysisStep: "vad" })
		.where(and(eq(replays.id, id), eq(replays.lifecycleState, "recording_uploaded")))
		.run();

	const claimed = findReplay(store, id);
	if (claimed === undefined) throw new ReplayNotFoundError(id);
	if (claimed.lifecycleState !== "analyzing") {
		throw new ReplayNotReadyForAnalysisError(id, claimed.lifecycleState);
	}

	let jobId: string;
	try {
		jobId = await jobRunner.enqueue({ replayId: id });
	} catch (cause) {
		store.db
			.update(replays)
			.set({ lifecycleState: "recording_uploaded", analysisStep: null })
			.where(and(eq(replays.id, id), eq(replays.lifecycleState, "analyzing")))
			.run();
		throw cause;
	}
	store.db.update(replays).set({ jobId }).where(eq(replays.id, id)).run();
	events.emit(id, { type: "state", lifecycle_state: "analyzing", analysis_step: "vad" });
	return { jobId, lifecycleState: "analyzing" };
}
