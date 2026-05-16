import type {
	SessionEndedEvent,
	SessionStartedEvent,
	ToolCalledEvent,
	TurnCompletedEvent,
} from "./ingest.types.ts";

export function makeSessionStartedEvent(
	overrides: Partial<SessionStartedEvent> = {},
): SessionStartedEvent {
	return {
		type: "session_started",
		agentId: "agent-x",
		startedAt: "2026-05-16T12:00:00.000Z",
		...overrides,
	};
}

export function makeTurnCompletedEvent(
	overrides: Partial<TurnCompletedEvent> = {},
): TurnCompletedEvent {
	return {
		type: "turn_completed",
		idx: 0,
		role: "user",
		text: "hello",
		timestamp: "2026-05-16T12:00:01.000Z",
		...overrides,
	};
}

export function makeToolCalledEvent(overrides: Partial<ToolCalledEvent> = {}): ToolCalledEvent {
	return {
		type: "tool_called",
		turnIdx: 0,
		idx: 0,
		name: "lookup",
		args: { q: "hello" },
		...overrides,
	};
}

export function makeSessionEndedEvent(
	overrides: Partial<SessionEndedEvent> = {},
): SessionEndedEvent {
	return {
		type: "session_ended",
		endedAt: "2026-05-16T12:05:00.000Z",
		durationMs: 300_000,
		...overrides,
	};
}

/** Builds a `Request` for POSTing one event to the ingest route. */
export function makeEventRequest(sessionId: string, event: unknown): Request {
	return new Request(`http://test.local/v1/sessions/${sessionId}/events`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(event),
	});
}
