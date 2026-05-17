import { and, count, eq } from "drizzle-orm";
import * as v from "valibot";

import { applyEvent } from "@/server/ingest/ingest.service.ts";
import {
	createReplayRun,
	finishReplayRun,
	getReplayRun,
	markReplayRunRunning,
	updateReplayRunProgress,
} from "@/server/store/replay-runs-repo.ts";
import { turns } from "@/server/store/schema.ts";
import { getSession } from "@/server/store/sessions-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { listToolCallsForTurn } from "@/server/store/tool-calls-repo.ts";
import { listTurnsForSession } from "@/server/store/turns-repo.ts";
import type { ReplayRunRow, TurnRow } from "@/server/store/types.ts";

import {
	CorruptToolCallJsonError,
	ReplayRunNotFoundError,
	SourceSessionNotFoundError,
	WebhookFetchError,
	WebhookHttpError,
	WebhookResponseNotJsonError,
	WebhookResponseShapeError,
} from "./replays.errors.ts";
import type {
	CreateReplayRequest,
	ReplayRunResponse,
	WebhookRequest,
	WebhookResponse,
} from "./replays.types.ts";
import { REPLAY_HISTORY_CAP, WebhookResponseSchema } from "./replays.types.ts";

/**
 * Insert a `replay_runs` row and return it. The worker that actually walks
 * the source session is started separately by the router (fire-and-forget).
 *
 * Throws `SourceSessionNotFoundError` if `req.sourceSessionId` doesn't exist.
 */
export function createReplay(store: Store, req: CreateReplayRequest): ReplayRunRow {
	if (getSession(store.db, req.sourceSessionId) === undefined) {
		throw new SourceSessionNotFoundError(req.sourceSessionId);
	}
	const id = crypto.randomUUID();
	const targetSessionId = `replay-${crypto.randomUUID()}`;
	const userTurnCount = countUserTurns(store, req.sourceSessionId);
	const row: ReplayRunRow = {
		id,
		sourceSessionId: req.sourceSessionId,
		targetSessionId,
		status: "pending",
		webhookUrl: req.webhookUrl,
		progressCompleted: 0,
		progressTotal: userTurnCount,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		error: null,
	};
	createReplayRun(store.db, row);
	return row;
}

function countUserTurns(store: Store, sessionId: string): number {
	const row = store.db
		.select({ n: count() })
		.from(turns)
		.where(and(eq(turns.sessionId, sessionId), eq(turns.role, "user")))
		.get();
	return row?.n ?? 0;
}

/**
 * Narrowed `fetch` shape used by the worker. The global `fetch` type is
 * wider than what we use; narrowing here lets test mocks pass plain
 * functions without unsafe casts.
 */
export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RunReplayOptions {
	store: Store;
	runId: string;
	fetchImpl?: WebhookFetch;
	now?: () => string;
}

/**
 * Walk the source session's user turns one at a time, POST each to the
 * webhook, and write the replies into the target session via the existing
 * ingest path. On any failure the run is marked `failed` with the error
 * message and the throw propagates so the caller can log it.
 */
export async function runReplay(opts: RunReplayOptions): Promise<void> {
	const { store, runId } = opts;
	const fetchImpl: WebhookFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
	const now = opts.now ?? (() => new Date().toISOString());

	const run = getReplayRun(store.db, runId);
	if (run === undefined) {
		throw new ReplayRunNotFoundError(runId);
	}

	markReplayRunRunning(store.db, runId);

	const startedAtMs = Date.now();
	try {
		await driveReplay(store, run, fetchImpl, now);
		const finishedAt = now();
		applyEvent(store, run.targetSessionId, {
			type: "session_ended",
			endedAt: finishedAt,
			durationMs: Date.now() - startedAtMs,
		});
		finishReplayRun(store.db, runId, "completed", { finishedAt });
	} catch (err) {
		const finishedAt = now();
		finishReplayRun(store.db, runId, "failed", {
			finishedAt,
			error: errorMessage(err),
		});
		throw err;
	}
}

async function driveReplay(
	store: Store,
	run: ReplayRunRow,
	fetchImpl: WebhookFetch,
	now: () => string,
): Promise<void> {
	const sourceTurns = listTurnsForSession(store.db, run.sourceSessionId);
	const userIndices = sourceTurns.flatMap((t, i) => (t.role === "user" ? [i] : []));

	if (userIndices.length === 0) {
		updateReplayRunProgress(store.db, run.id, { completed: 0, total: 0 });
		return;
	}

	applyEvent(store, run.targetSessionId, {
		type: "session_started",
		agentId: `replay:${run.sourceSessionId}`,
		startedAt: now(),
	});

	let completed = 0;
	let targetIdx = 0;

	for (const userIdx of userIndices) {
		const userTurn = sourceTurns[userIdx];
		if (userTurn === undefined) continue;

		const history = sourceTurns
			.slice(0, userIdx)
			.slice(-REPLAY_HISTORY_CAP)
			.map((t) => ({ role: t.role, text: t.text }));

		const recordedToolResults = readRecordedToolResults(
			store,
			run.sourceSessionId,
			sourceTurns[userIdx + 1],
		);

		const webhookResponse = await callWebhook(fetchImpl, run.webhookUrl, {
			sessionId: run.targetSessionId,
			turnIdx: targetIdx + 1,
			userText: userTurn.text,
			history,
			recordedToolResults,
		});

		applyEvent(store, run.targetSessionId, {
			type: "turn_completed",
			idx: targetIdx,
			role: "user",
			text: userTurn.text,
			timestamp: now(),
		});

		const agentIdx = targetIdx + 1;
		applyEvent(store, run.targetSessionId, {
			type: "turn_completed",
			idx: agentIdx,
			role: "agent",
			text: webhookResponse.agentText,
			timestamp: now(),
			...(webhookResponse.responseLatencyMs !== undefined
				? { responseLatencyMs: webhookResponse.responseLatencyMs }
				: {}),
			...(webhookResponse.interrupted !== undefined
				? { interrupted: webhookResponse.interrupted }
				: {}),
		});

		webhookResponse.toolCalls.forEach((call, i) => {
			applyEvent(store, run.targetSessionId, {
				type: "tool_called",
				turnIdx: agentIdx,
				idx: i,
				name: call.name,
				args: call.args,
			});
		});

		targetIdx += 2;
		completed += 1;
		updateReplayRunProgress(store.db, run.id, { completed });
	}
}

function readRecordedToolResults(
	store: Store,
	sourceSessionId: string,
	followingTurn: TurnRow | undefined,
): WebhookRequest["recordedToolResults"] {
	if (followingTurn?.role !== "agent") return [];
	return listToolCallsForTurn(store.db, followingTurn.id).map((tc) => ({
		name: tc.name,
		args: parseToolJson(sourceSessionId, followingTurn.id, "args", tc.argsJson),
		result:
			tc.resultJson === null
				? null
				: parseToolJson(sourceSessionId, followingTurn.id, "result", tc.resultJson),
	}));
}

function parseToolJson(
	sessionId: string,
	turnId: string,
	field: "args" | "result",
	raw: string,
): unknown {
	try {
		return JSON.parse(raw);
	} catch (cause) {
		throw new CorruptToolCallJsonError(sessionId, turnId, field, cause);
	}
}

async function callWebhook(
	fetchImpl: WebhookFetch,
	url: string,
	body: WebhookRequest,
): Promise<WebhookResponse> {
	let res: Response;
	try {
		// `redirect: "manual"` so a benign-looking webhook can't 302-redirect to
		// an internal endpoint (cloud metadata, localhost services). The schema
		// already restricts the *initial* URL to http(s); this blocks the
		// follow-up. A 3xx is surfaced as a WebhookHttpError below.
		res = await fetchImpl(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			redirect: "manual",
		});
	} catch (cause) {
		throw new WebhookFetchError(`Failed to reach webhook: ${errorMessage(cause)}`, { cause });
	}
	if (!res.ok) {
		throw new WebhookHttpError(res.status);
	}
	let raw: unknown;
	try {
		raw = await res.json();
	} catch (cause) {
		throw new WebhookResponseNotJsonError({ cause });
	}
	const parsed = v.safeParse(WebhookResponseSchema, raw);
	if (!parsed.success) {
		throw new WebhookResponseShapeError(parsed.issues);
	}
	return parsed.output;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Wire-shape projection: `replay_runs` row → `ReplayRunResponse`. */
export function toReplayRunResponse(row: ReplayRunRow): ReplayRunResponse {
	return {
		id: row.id,
		sourceSessionId: row.sourceSessionId,
		targetSessionId: row.targetSessionId,
		status: row.status,
		progress: { completed: row.progressCompleted, total: row.progressTotal },
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
		error: row.error,
	};
}
