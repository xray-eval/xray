import { match } from "ts-pattern";

import { ensureStubSession, markSessionEnded, saveSession } from "@/server/store/sessions-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { appendToolCallIdempotent } from "@/server/store/tool-calls-repo.ts";
import { appendTurnIdempotent, getTurnByIdx } from "@/server/store/turns-repo.ts";

import { UnknownTurnError } from "./ingest.errors.ts";
import type { IngestEvent } from "./ingest.types.ts";

/**
 * Apply a validated ingest event to the store.
 *
 * Every branch MUST be idempotent — replaying the same event (same
 * identity key) is a no-op. That's the contract the router promises
 * callers; this is where it's actually enforced (via the underlying
 * repo functions, all of which use UPSERT / INSERT-OR-IGNORE).
 */
export function applyEvent(store: Store, sessionId: string, event: IngestEvent): void {
	const db = store.db;
	match(event)
		.with({ type: "session_started" }, (e) => {
			saveSession(db, {
				id: sessionId,
				source: "ingest",
				provider: null,
				agentId: e.agentId,
				startedAt: e.startedAt,
				endedAt: null,
				durationMs: null,
			});
		})
		.with({ type: "turn_completed" }, (e) => {
			ensureStubSession(db, sessionId, e.timestamp);
			appendTurnIdempotent(db, sessionId, {
				id: crypto.randomUUID(),
				idx: e.idx,
				role: e.role,
				text: e.text,
				ts: e.timestamp,
				activeNodeId: null,
				edgeFiredId: null,
				edgeReasoning: null,
				promptSeen: null,
				llmLatencyMs: e.llmLatencyMs ?? null,
			});
		})
		.with({ type: "tool_called" }, (e) => {
			// No `ensureStubSession` here: the `turns.session_id` FK guarantees
			// the session exists whenever a turn exists, so the lookup below
			// is sufficient.
			const turn = getTurnByIdx(db, sessionId, e.turnIdx);
			if (!turn) {
				throw new UnknownTurnError(sessionId, e.turnIdx);
			}
			appendToolCallIdempotent(db, turn.id, {
				idx: e.idx,
				name: e.name,
				argsJson: JSON.stringify(e.args ?? null),
				resultJson: e.result === undefined ? null : JSON.stringify(e.result),
				latencyMs: e.latencyMs ?? null,
			});
		})
		.with({ type: "session_ended" }, (e) => {
			ensureStubSession(db, sessionId, e.endedAt);
			markSessionEnded(db, sessionId, e.endedAt, e.durationMs);
		})
		.exhaustive();
}
