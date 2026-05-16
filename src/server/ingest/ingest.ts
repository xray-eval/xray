import { Hono } from "hono";
import * as v from "valibot";

import { ensureStubSession, markSessionEnded, saveSession } from "@/server/store/sessions-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { appendToolCalls, countToolCallsForTurn } from "@/server/store/tool-calls-repo.ts";
import { appendTurnIdempotent, getTurnByIdx } from "@/server/store/turns-repo.ts";

import { InvalidEventError, UnknownTurnError } from "./errors.ts";
import type { IngestEvent } from "./types.ts";
import { IngestEventSchema } from "./types.ts";

/**
 * HTTP ingest router. Mounted at `/v1`; final URL is
 * `POST /v1/sessions/:id/events`. Localhost-only — no auth.
 *
 * Idempotency: replaying any event with the same identity key
 * (`session_id` + `idx` for turns; `session_id` for session_started /
 * session_ended) is a no-op. Second POST never duplicates a row.
 */
export function createIngestRouter(store: Store): Hono {
	const router = new Hono();

	router.post("/sessions/:id/events", async (c) => {
		const sessionId = c.req.param("id");

		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return c.json(
				{
					error: "invalid_event",
					issues: [{ message: "Request body must be valid JSON" }],
				},
				400,
			);
		}

		const parsed = v.safeParse(IngestEventSchema, raw);
		if (!parsed.success) {
			throw new InvalidEventError(sessionId, parsed.issues);
		}

		applyEvent(store, sessionId, parsed.output);
		return c.json({ ok: true });
	});

	router.onError((err, c) => {
		if (err instanceof InvalidEventError) {
			return c.json({ error: "invalid_event", issues: err.issues }, 400);
		}
		if (err instanceof UnknownTurnError) {
			return c.json({ error: "unknown_turn", sessionId: err.sessionId, turnIdx: err.turnIdx }, 422);
		}
		console.error("store error during ingest", err);
		return c.json({ error: "store_failure" }, 500);
	});

	return router;
}

function applyEvent(store: Store, sessionId: string, event: IngestEvent): void {
	const db = store.db;
	switch (event.type) {
		case "session_started":
			saveSession(db, {
				id: sessionId,
				source: "ingest",
				provider: null,
				agentId: event.agentId,
				startedAt: event.startedAt,
				endedAt: null,
				durationMs: null,
			});
			return;

		case "turn_completed":
			ensureStubSession(db, sessionId, event.timestamp);
			appendTurnIdempotent(db, sessionId, {
				id: crypto.randomUUID(),
				idx: event.idx,
				role: event.role,
				text: event.text,
				ts: event.timestamp,
				activeNodeId: null,
				edgeFiredId: null,
				edgeReasoning: null,
				promptSeen: null,
				llmLatencyMs: event.llmLatencyMs ?? null,
			});
			return;

		case "tool_called": {
			ensureStubSession(db, sessionId, new Date().toISOString());
			const turn = getTurnByIdx(db, sessionId, event.turnIdx);
			if (!turn) {
				throw new UnknownTurnError(sessionId, event.turnIdx);
			}
			appendToolCalls(db, turn.id, [
				{
					idx: countToolCallsForTurn(db, turn.id),
					name: event.name,
					argsJson: JSON.stringify(event.args ?? null),
					resultJson: event.result === undefined ? null : JSON.stringify(event.result),
					latencyMs: event.latencyMs ?? null,
				},
			]);
			return;
		}

		case "session_ended":
			ensureStubSession(db, sessionId, event.endedAt);
			markSessionEnded(db, sessionId, event.endedAt, event.durationMs);
			return;
	}
}
