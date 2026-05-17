import type { CreateReplayRequest, ReplayRunResponse, WebhookResponse } from "./replays.types.ts";

export function makeCreateReplayRequest(
	overrides: Partial<CreateReplayRequest> = {},
): CreateReplayRequest {
	return {
		sourceSessionId: "sess-1",
		webhookUrl: "https://example.test/webhook",
		...overrides,
	};
}

export function makeWebhookResponse(overrides: Partial<WebhookResponse> = {}): WebhookResponse {
	return {
		agentText: "hi back",
		toolCalls: [],
		...overrides,
	};
}

export function makeReplayRunResponse(
	overrides: Partial<ReplayRunResponse> = {},
): ReplayRunResponse {
	return {
		id: "replay-1",
		sourceSessionId: "sess-1",
		targetSessionId: "target-1",
		status: "pending",
		mode: "text",
		progress: { completed: 0, total: 0 },
		startedAt: "2026-05-16T12:00:00.000Z",
		finishedAt: null,
		error: null,
		...overrides,
	};
}

/** Builds a `Request` for `POST /v1/replays`. */
export function makeCreateReplayRequestObject(body: unknown): Request {
	return new Request("http://test.local/v1/replays", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Builds a `Request` for `GET /v1/replays/:id`. */
export function makeGetReplayRequest(id: string): Request {
	return new Request(`http://test.local/v1/replays/${id}`, { method: "GET" });
}
