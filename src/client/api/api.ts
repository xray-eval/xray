import * as v from "valibot";

import {
	ConversationResponseSchema,
	ListConversationsResponseSchema,
} from "@/server/conversations/conversations.types.ts";
import {
	CompareReplaysResponseSchema,
	ListReplaysResponseSchema,
	ReplayDetailResponseSchema,
	ReplayResultSchema,
} from "@/server/replays/replays.types.ts";
import type { CompareRunConfigsRequest } from "@/server/run-configs/run-configs.types.ts";
import {
	CompareRunConfigsResponseSchema,
	ListRunConfigsResponseSchema,
	RunConfigDetailResponseSchema,
} from "@/server/run-configs/run-configs.types.ts";

import { ApiRequestFailedError, ApiResponseValidationError } from "./api.errors.ts";
import type {
	CompareReplaysResponse,
	CompareRunConfigsResponse,
	ConversationResponse,
	ListConversationsResponse,
	ListReplaysResponse,
	ListRunConfigsResponse,
	ReplayDetailResponse,
	ReplayResult,
	ReplaySelection,
	RunConfigDetailResponse,
} from "./api.types.ts";

/**
 * All network calls live here so components don't reach for `fetch` directly
 * (per the client `server-state` + boundary-validation rules). `signal` is
 * always plumbed from the TanStack Query call so cancellation works on
 * unmount / refetch.
 */
const BASE = ""; // Same-origin: the SPA is served by the same Bun process.

async function getJson<TSchema extends v.GenericSchema>(
	path: string,
	schema: TSchema,
	signal?: AbortSignal,
): Promise<v.InferOutput<TSchema>> {
	const init: RequestInit = signal === undefined ? {} : { signal };
	const res = await fetch(`${BASE}${path}`, init);
	if (!res.ok) throw new ApiRequestFailedError("GET", path, res.status, res.statusText);
	const raw: unknown = await res.json();
	const parsed = v.safeParse(schema, raw);
	if (!parsed.success) {
		throw new ApiResponseValidationError("GET", path);
	}
	return parsed.output;
}

async function postJson<TSchema extends v.GenericSchema>(
	path: string,
	body: unknown,
	schema: TSchema,
	signal?: AbortSignal,
): Promise<v.InferOutput<TSchema>> {
	const init: RequestInit = {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		...(signal === undefined ? {} : { signal }),
	};
	const res = await fetch(`${BASE}${path}`, init);
	if (!res.ok) throw new ApiRequestFailedError("POST", path, res.status, res.statusText);
	const raw: unknown = await res.json();
	const parsed = v.safeParse(schema, raw);
	if (!parsed.success) throw new ApiResponseValidationError("POST", path);
	return parsed.output;
}

export function listConversations(signal?: AbortSignal): Promise<ListConversationsResponse> {
	return getJson("/v1/conversations", ListConversationsResponseSchema, signal);
}

export function getConversation(hash: string, signal?: AbortSignal): Promise<ConversationResponse> {
	return getJson(`/v1/conversations/${hash}`, ConversationResponseSchema, signal);
}

export function listReplaysForConversation(
	hash: string,
	signal?: AbortSignal,
): Promise<ListReplaysResponse> {
	return getJson(`/v1/conversations/${hash}/replays`, ListReplaysResponseSchema, signal);
}

export function getReplay(id: string, signal?: AbortSignal): Promise<ReplayDetailResponse> {
	return getJson(`/v1/replays/${id}`, ReplayDetailResponseSchema, signal);
}

/**
 * The server answers 409 until evaluation has run, so callers gate this on
 * `lifecycle_state === "completed"` (TanStack `skipToken`) rather than letting
 * it fail-and-retry.
 */
export function getReplayResult(id: string, signal?: AbortSignal): Promise<ReplayResult> {
	return getJson(`/v1/replays/${id}/result`, ReplayResultSchema, signal);
}

export function compareReplays(
	replayIds: readonly string[],
	signal?: AbortSignal,
): Promise<CompareReplaysResponse> {
	return postJson(
		"/v1/replays/compare",
		{ replay_ids: replayIds },
		CompareReplaysResponseSchema,
		signal,
	);
}

export function listRunConfigs(signal?: AbortSignal): Promise<ListRunConfigsResponse> {
	return getJson("/v1/run-configs", ListRunConfigsResponseSchema, signal);
}

export function compareRunConfigs(
	body: CompareRunConfigsRequest,
	signal?: AbortSignal,
): Promise<CompareRunConfigsResponse> {
	return postJson("/v1/run-configs/compare", body, CompareRunConfigsResponseSchema, signal);
}

export function getRunConfigDetail(
	hash: string,
	replaySelection: ReplaySelection,
	signal?: AbortSignal,
): Promise<RunConfigDetailResponse> {
	return getJson(
		`/v1/run-configs/${hash}?replay_selection=${replaySelection}`,
		RunConfigDetailResponseSchema,
		signal,
	);
}

export function replayAudioUrl(replayId: string): string {
	return `/v1/replays/${replayId}/audio`;
}

export function replayEventsUrl(replayId: string): string {
	return `/v1/replays/${replayId}/events`;
}
