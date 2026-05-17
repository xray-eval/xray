import * as v from "valibot";

import type { CreateReplayRequest, ReplayRunResponse } from "@/server/replays/replays.types.ts";
import { ReplayRunResponseSchema } from "@/server/replays/replays.types.ts";

import { ReplayInvalidResponseError, ReplayLoadError } from "../replays/errors.ts";

export interface CreateReplayParams {
	body: CreateReplayRequest;
	/** Optional — POST is a mutation; useMutation doesn't provide a signal and there's nothing to cancel. */
	signal?: AbortSignal;
}

/** POST /v1/replays — start a new replay run. */
export async function createReplay({
	body,
	signal,
}: CreateReplayParams): Promise<ReplayRunResponse> {
	const url = new URL("/v1/replays", window.location.origin);
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
