import * as v from "valibot";

import type {
	CreateReplayRequest,
	ListReplayRunsResponse,
	ReplayMode,
	ReplayRunResponse,
} from "@/server/replays/replays.types.ts";
import {
	ListReplayRunsResponseSchema,
	ReplayRunResponseSchema,
} from "@/server/replays/replays.types.ts";

import { ReplayInvalidResponseError, ReplayLoadError } from "../replays/errors.ts";

const REPLAY_MODE_TO_PATH: Record<ReplayMode, string> = {
	text: "/v1/replays",
	realtime: "/v1/replays/realtime",
};

export interface CreateReplayParams {
	body: CreateReplayRequest;
	/** Defaults to the text path; pass `"realtime"` to start a V2V WebSocket run. */
	mode?: ReplayMode;
	/** Optional — POST is a mutation; useMutation doesn't provide a signal and there's nothing to cancel. */
	signal?: AbortSignal;
}

/** POST /v1/replays{,/realtime} — start a new replay run. */
export async function createReplay({
	body,
	mode = "text",
	signal,
}: CreateReplayParams): Promise<ReplayRunResponse> {
	const url = new URL(REPLAY_MODE_TO_PATH[mode], window.location.origin);
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		...(signal !== undefined ? { signal } : {}),
	});
	if (!res.ok) {
		const errorBody = await res.text();
		throw new ReplayLoadError(res.status, errorBody || `Server returned ${res.status}`);
	}
	const parsed = v.safeParse(ReplayRunResponseSchema, await res.json());
	if (!parsed.success) throw new ReplayInvalidResponseError(parsed.issues);
	return parsed.output;
}

export interface FetchReplayParams {
	id: string;
	signal: AbortSignal;
}

/** GET /v1/replays/:id — read current state, progress, error. */
export async function fetchReplay({ id, signal }: FetchReplayParams): Promise<ReplayRunResponse> {
	const url = new URL(`/v1/replays/${encodeURIComponent(id)}`, window.location.origin);
	const res = await fetch(url, { signal });
	if (!res.ok) throw new ReplayLoadError(res.status);
	const parsed = v.safeParse(ReplayRunResponseSchema, await res.json());
	if (!parsed.success) throw new ReplayInvalidResponseError(parsed.issues);
	return parsed.output;
}

export interface FetchReplaysForSessionParams {
	sessionId: string;
	signal: AbortSignal;
}

/** GET /v1/sessions/:sessionId/replays — list every replay of one source session. */
export async function fetchReplaysForSession({
	sessionId,
	signal,
}: FetchReplaysForSessionParams): Promise<ListReplayRunsResponse> {
	const url = new URL(
		`/v1/sessions/${encodeURIComponent(sessionId)}/replays`,
		window.location.origin,
	);
	const res = await fetch(url, { signal });
	if (!res.ok) throw new ReplayLoadError(res.status);
	const parsed = v.safeParse(ListReplayRunsResponseSchema, await res.json());
	if (!parsed.success) throw new ReplayInvalidResponseError(parsed.issues);
	return parsed.output;
}
