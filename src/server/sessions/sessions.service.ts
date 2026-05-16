import { match, P } from "ts-pattern";

import { listSessions } from "@/server/store/sessions-repo.ts";
import type { Store } from "@/server/store/store.ts";
import type { Session } from "@/server/store/types.ts";

import { encodeCursor } from "./cursor/cursor.ts";
import { InconsistentSessionRowError } from "./sessions.errors.ts";
import type { ListSessionsQuery } from "./sessions.query.ts";
import type { ListSessionsResponse, SessionListItem } from "./sessions.types.ts";

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
