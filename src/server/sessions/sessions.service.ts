import { match, P } from "ts-pattern";

import { getSession, listSessions } from "@/server/store/sessions-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { listToolCallsForSession } from "@/server/store/tool-calls-repo.ts";
import { listTurnsForSession } from "@/server/store/turns-repo.ts";
import type { Session, ToolCallRow, TurnRow } from "@/server/store/types.ts";

import { encodeCursor } from "./cursor/cursor.ts";
import {
	CorruptToolCallJsonError,
	InconsistentSessionRowError,
	SessionNotFoundError,
} from "./sessions.errors.ts";
import type { ListSessionsQuery } from "./sessions.query.ts";
import type {
	Conversation,
	ConversationToolCall,
	ConversationTurn,
	ListSessionsResponse,
	SessionListItem,
} from "./sessions.types.ts";

/**
 * List sessions newest-first with optional `agentId` filter and `(startedAt, id)`
 * cursor pagination. `nextCursor` is non-null exactly when the page filled to
 * `limit`; clients echo it back as `?cursor=...` for the next page.
 *
 * Source-agnostic: rows from both the ingest path and adapter polls land here.
 * The route does not trigger adapter syncs — that's a separate
 * `/v1/agents/:id/conversations` endpoint (issue #14).
 */
export function listSessionsForApi(store: Store, query: ListSessionsQuery): ListSessionsResponse {
	const { limit } = query;
	const rows = listSessions(store.db, {
		...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
		limit,
		...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
	});
	const sessions = rows.map(toListItem);
	// `nextCursor` is non-null only when the page filled — a short page means
	// no more rows, so the client should stop polling.
	const last = rows.length === limit ? rows.at(-1) : undefined;
	const nextCursor =
		last !== undefined ? encodeCursor({ startedAt: last.startedAt, id: last.id }) : null;
	return { sessions, nextCursor };
}

function toListItem(row: Session): SessionListItem {
	return {
		id: row.id,
		agentId: row.agentId,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		durationMs: row.durationMs,
		source: composeSource(row),
	};
}

function composeSource(row: Session): SessionListItem["source"] {
	return match(row)
		.with({ source: "ingest" }, () => "ingest" as const)
		.with({ source: "adapter", provider: P.string }, (r) => `adapter:${r.provider}` as const)
		.with({ source: "adapter", provider: null }, () => {
			throw new InconsistentSessionRowError(row.id);
		})
		.exhaustive();
}

/**
 * Read one conversation by id: session metadata + ordered turns + per-turn
 * tool calls. Source-agnostic — works equally for ingest- and adapter-sourced
 * sessions. For adapter-mode the on-demand provider sync is a separate
 * endpoint (`/v1/agents/:id/conversations`, issue #14); this route reads
 * what's already in the store.
 *
 * Throws:
 * - `SessionNotFoundError` if no row matches.
 * - `InconsistentSessionRowError` if `source='adapter'` and `provider` is null.
 * - `CorruptToolCallJsonError` if a `tool_calls.{args,result}_json` value
 *   fails `JSON.parse`.
 */
export function getConversationForApi(store: Store, sessionId: string): Conversation {
	const session = getSession(store.db, sessionId);
	if (session === undefined) {
		throw new SessionNotFoundError(sessionId);
	}
	const source = composeSource(session);
	const turnRows = listTurnsForSession(store.db, sessionId);
	const toolCallRows = listToolCallsForSession(store.db, sessionId);
	const toolCallsByTurnId = groupToolCallsByTurnId(sessionId, toolCallRows);
	const turns = turnRows.map((row) => toConversationTurn(row, toolCallsByTurnId.get(row.id) ?? []));
	return {
		id: session.id,
		agentId: session.agentId,
		startedAt: session.startedAt,
		endedAt: session.endedAt,
		durationMs: session.durationMs,
		source,
		turns,
	};
}

function groupToolCallsByTurnId(
	sessionId: string,
	rows: ToolCallRow[],
): Map<string, ConversationToolCall[]> {
	const out = new Map<string, ConversationToolCall[]>();
	for (const row of rows) {
		const list = out.get(row.turnId) ?? [];
		list.push(toConversationToolCall(sessionId, row));
		out.set(row.turnId, list);
	}
	return out;
}

function toConversationTurn(row: TurnRow, toolCalls: ConversationToolCall[]): ConversationTurn {
	return {
		id: row.id,
		idx: row.idx,
		role: row.role,
		text: row.text,
		timestamp: row.ts,
		responseLatencyMs: row.responseLatencyMs,
		interrupted: row.interrupted,
		interruptedAtMs: row.interruptedAtMs,
		toolCalls,
	};
}

function toConversationToolCall(sessionId: string, row: ToolCallRow): ConversationToolCall {
	const ctx = { sessionId, turnId: row.turnId };
	return {
		idx: row.idx,
		name: row.name,
		args: parseJsonOrThrow(ctx, "args", row.argsJson),
		result: row.resultJson === null ? null : parseJsonOrThrow(ctx, "result", row.resultJson),
		latencyMs: row.latencyMs,
	};
}

interface ParseContext {
	readonly sessionId: string;
	readonly turnId: string;
}

function parseJsonOrThrow(ctx: ParseContext, field: "args" | "result", raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (cause) {
		throw new CorruptToolCallJsonError(ctx.sessionId, ctx.turnId, field, cause);
	}
}
