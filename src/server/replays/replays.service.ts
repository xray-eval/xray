import { and, count, eq } from "drizzle-orm";
import * as v from "valibot";

import { applyEvent } from "@/server/ingest/ingest.service.ts";
import { SessionNotFoundError } from "@/server/sessions/sessions.errors.ts";
import {
	createReplayRun,
	finishReplayRun,
	getReplayRun,
	listReplayRunsBySourceSession,
	markReplayRunRunning,
	updateReplayRunProgress,
} from "@/server/store/replay-runs-repo.ts";
import { turns } from "@/server/store/schema.ts";
import { getSession } from "@/server/store/sessions-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { listToolCallsForSession } from "@/server/store/tool-calls-repo.ts";
import { listTurnsForSession } from "@/server/store/turns-repo.ts";
import type { ReplayRunRow, ToolCallRow, TurnRow } from "@/server/store/types.ts";

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
	ListReplayRunsResponse,
	ReplayRunResponse,
	WebhookRequest,
	WebhookResponse,
} from "./replays.types.ts";
import { REPLAY_HISTORY_CAP, WebhookResponseSchema } from "./replays.types.ts";

/**
 * Insert a `replay_runs` row and return it — shared by every transport
 * (text, realtime, future). The worker that actually walks the source
 * session is started separately by the router (fire-and-forget); this
 * call only stages the row + counts user turns for `progress_total`.
 *
 * Throws `SourceSessionNotFoundError` if `req.sourceSessionId` doesn't exist.
 */
export interface CreateReplayRowOptions {
	sourceSessionId: string;
	webhookUrl: string;
	mode: ReplayRunRow["mode"];
}
export function createReplayRow(store: Store, opts: CreateReplayRowOptions): ReplayRunRow {
	if (getSession(store.db, opts.sourceSessionId) === undefined) {
		throw new SourceSessionNotFoundError(opts.sourceSessionId);
	}
	const id = crypto.randomUUID();
	const targetSessionId = `replay-${crypto.randomUUID()}`;
	const userTurnCount = countUserTurns(store, opts.sourceSessionId);
	const row: ReplayRunRow = {
		id,
		sourceSessionId: opts.sourceSessionId,
		targetSessionId,
		status: "pending",
		mode: opts.mode,
		webhookUrl: opts.webhookUrl,
		progressCompleted: 0,
		progressTotal: userTurnCount,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		error: null,
	};
	createReplayRun(store.db, row);
	return row;
}

export function createReplay(store: Store, req: CreateReplayRequest): ReplayRunRow {
	return createReplayRow(store, {
		sourceSessionId: req.sourceSessionId,
		webhookUrl: req.webhookUrl,
		mode: "text",
	});
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
 * Generic worker shell shared by every transport: look up the row, flip
 * `pending → running`, run the transport-specific `drive` callback, then
 * bookend with `session_ended` + `finishReplayRun(completed|failed)`. Each
 * transport supplies its own `drive` (text POSTs per turn, realtime opens
 * a WS). The wrapper owns the row lifecycle + error capture so every
 * mode lands a consistent `replay_runs.error` value.
 */
export interface RunReplayWorkerOptions {
	store: Store;
	runId: string;
	now?: () => string;
}
export type ReplayDriver = (args: {
	store: Store;
	run: ReplayRunRow;
	now: () => string;
}) => Promise<void>;

export async function runReplayWorker(
	opts: RunReplayWorkerOptions,
	drive: ReplayDriver,
): Promise<void> {
	const { store, runId } = opts;
	const now = opts.now ?? (() => new Date().toISOString());

	const run = getReplayRun(store.db, runId);
	if (run === undefined) {
		throw new ReplayRunNotFoundError(runId);
	}

	markReplayRunRunning(store.db, runId);

	const startedAtMs = Date.now();
	try {
		await drive({ store, run, now });
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
 * ingest path. Composes on `runReplayWorker` so the row-lifecycle + error
 * capture stay in one place across transports.
 */
export async function runReplay(opts: RunReplayOptions): Promise<void> {
	const fetchImpl: WebhookFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
	await runReplayWorker(
		{ store: opts.store, runId: opts.runId, ...(opts.now ? { now: opts.now } : {}) },
		async ({ store, run, now }) => {
			await driveReplay(store, run, fetchImpl, now);
		},
	);
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

	// One query for every tool call in the source, grouped by turnId, so a
	// long source session doesn't issue one point-lookup per agent turn.
	const callsByTurnId = groupToolCallsByTurnId(
		listToolCallsForSession(store.db, run.sourceSessionId),
	);

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

		const followingTurn = sourceTurns[userIdx + 1];
		const recordedToolResults =
			followingTurn?.role === "agent"
				? toWebhookRecordedToolResults(
						run.sourceSessionId,
						followingTurn,
						callsByTurnId.get(followingTurn.id) ?? [],
					)
				: [];

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

function toWebhookRecordedToolResults(
	sourceSessionId: string,
	agentTurn: TurnRow,
	calls: ToolCallRow[],
): WebhookRequest["recordedToolResults"] {
	return calls.map((tc) => ({
		name: tc.name,
		args: parseToolJson(sourceSessionId, agentTurn.id, "args", tc.argsJson),
		result:
			tc.resultJson === null
				? null
				: parseToolJson(sourceSessionId, agentTurn.id, "result", tc.resultJson),
	}));
}

/** Index tool-call rows by their parent turn id. Shared by every replay
 *  transport that needs per-turn lookups against the source session. */
export function groupToolCallsByTurnId(rows: ToolCallRow[]): Map<string, ToolCallRow[]> {
	const out = new Map<string, ToolCallRow[]>();
	for (const tc of rows) {
		const list = out.get(tc.turnId);
		if (list === undefined) out.set(tc.turnId, [tc]);
		else list.push(tc);
	}
	return out;
}

/** Parse a `tool_calls.{args,result}_json` value. Throws
 *  `CorruptToolCallJsonError` when the column holds unparseable text —
 *  silently feeding `null` would mask data corruption as a different replay
 *  output. Shared across transports. */
export function parseToolJson(
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

/** Extract a string message from any thrown value. Shared by every
 *  transport so the `replay_runs.error` column carries a consistent
 *  shape regardless of which path failed. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * List every replay whose source is `sessionId`, newest-first. Throws
 * `SessionNotFoundError` (from the sessions slice — same shape, same 404
 * envelope as `GET /v1/sessions/:id`) when the session itself doesn't exist.
 * Empty list for an existing session is a successful 200 with `items: []`.
 */
export function listReplaysForSession(store: Store, sessionId: string): ListReplayRunsResponse {
	if (getSession(store.db, sessionId) === undefined) {
		throw new SessionNotFoundError(sessionId);
	}
	const rows = listReplayRunsBySourceSession(store.db, sessionId);
	return { items: rows.map(toReplayRunResponse) };
}

/** Wire-shape projection: `replay_runs` row → `ReplayRunResponse`. */
export function toReplayRunResponse(row: ReplayRunRow): ReplayRunResponse {
	return {
		id: row.id,
		sourceSessionId: row.sourceSessionId,
		targetSessionId: row.targetSessionId,
		status: row.status,
		mode: row.mode,
		progress: { completed: row.progressCompleted, total: row.progressTotal },
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
		error: row.error,
	};
}
