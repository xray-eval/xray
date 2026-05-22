import * as v from "valibot";

import {
	ConversationResponseSchema,
	ListConversationsResponseSchema,
} from "@/server/conversations/conversations.types.ts";
import {
	CompareReplaysResponseSchema,
	ListReplaysResponseSchema,
	ReplayDetailResponseSchema,
} from "@/server/replays/replays.types.ts";

import { ApiRequestFailedError, ApiResponseValidationError } from "./api.errors.ts";
import type {
	CompareReplaysResponse,
	ConversationResponse,
	ListConversationsResponse,
	ListReplaysResponse,
	ReplayDetailResponse,
} from "./api.types.ts";

/**
 * REST client for xray's HTTP API. All network calls live here so components
 * don't reach for `fetch` directly (per the client `.claude/rules/server-state`
 * + boundary-validation rules). Every response is validated against its
 * server-side schema at the boundary.
 *
 * `signal` is always plumbed from the TanStack Query call so cancellation
 * works on unmount / refetch.
 */
const BASE = ""; // Same-origin: the SPA is served by the same Bun process.

async function getJson<T>(
	path: string,
	schema: v.GenericSchema<T>,
	signal?: AbortSignal,
): Promise<T> {
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

async function postJson<T>(
	path: string,
	body: unknown,
	schema: v.GenericSchema<T>,
	signal?: AbortSignal,
): Promise<T> {
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

export function replayAudioUrl(replayId: string): string {
	return `/v1/replays/${replayId}/audio`;
}
