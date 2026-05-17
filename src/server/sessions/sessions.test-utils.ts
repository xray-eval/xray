import { encodeCursor } from "./cursor/cursor.ts";
import type {
	Conversation,
	ConversationToolCall,
	ConversationTurn,
	ListSessionsResponse,
	SessionListItem,
} from "./sessions.types.ts";

/** Builds a `Request` for GETting the sessions list with optional query params. */
export function makeListRequest(query: Record<string, string> = {}): Request {
	const url = new URL("http://test.local/v1/sessions");
	for (const [k, v] of Object.entries(query)) {
		url.searchParams.set(k, v);
	}
	return new Request(url, { method: "GET" });
}

/** Builds a `Request` for GETting a single conversation by id. */
export function makeGetConversationRequest(sessionId: string): Request {
	return new Request(`http://test.local/v1/sessions/${sessionId}`, { method: "GET" });
}

/** Encode a cursor exactly the way the server emits one — same helper, no drift. */
export function makeCursor(payload: { startedAt: string; id: string }): string {
	return encodeCursor(payload);
}

export function makeSessionListItem(overrides: Partial<SessionListItem> = {}): SessionListItem {
	return {
		id: "sess-1",
		agentId: "agent-1",
		startedAt: "2026-05-16T12:00:00.000Z",
		endedAt: "2026-05-16T12:05:00.000Z",
		durationMs: 300_000,
		source: "ingest",
		...overrides,
	};
}

export function makeListSessionsResponse(
	overrides: Partial<ListSessionsResponse> = {},
): ListSessionsResponse {
	return {
		sessions: [],
		nextCursor: null,
		...overrides,
	};
}

export function makeConversationToolCall(
	overrides: Partial<ConversationToolCall> = {},
): ConversationToolCall {
	return {
		idx: 0,
		name: "lookup",
		args: { q: "hello" },
		result: null,
		latencyMs: null,
		...overrides,
	};
}

export function makeConversationTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
	return {
		id: "turn-1",
		idx: 0,
		role: "user",
		text: "hello",
		timestamp: "2026-05-16T12:00:01.000Z",
		responseLatencyMs: null,
		interrupted: null,
		interruptedAtMs: null,
		toolCalls: [],
		...overrides,
	};
}

export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
	return {
		id: "sess-1",
		agentId: "agent-1",
		startedAt: "2026-05-16T12:00:00.000Z",
		endedAt: "2026-05-16T12:05:00.000Z",
		durationMs: 300_000,
		source: "ingest",
		turns: [],
		...overrides,
	};
}
