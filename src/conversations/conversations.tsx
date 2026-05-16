import { useCallback, useEffect, useState } from "react";
import { match } from "ts-pattern";
import * as v from "valibot";

import type { ListSessionsResponse, SessionListItem } from "@/server/sessions/sessions.types.ts";
// The client imports the server's response schema directly — single source of
// truth for the wire contract, per `.claude/rules/boundary-validation.md` §2.
// A schema drift breaks both ends at typecheck rather than at runtime.
import { ListSessionsResponseSchema } from "@/server/sessions/sessions.types.ts";

import { SessionsInvalidResponseError, SessionsLoadError } from "./errors.ts";

export interface ConversationsListProps {
	/** Optional `agentId` filter passed through as `?agentId=` to the server. */
	agentId?: string;
	/**
	 * API base URL. Defaults to `window.location.origin` so the SPA and the
	 * server are co-located. Bun's native fetch rejects relative URLs, so
	 * an absolute base is required everywhere — including tests.
	 */
	apiBase?: string;
}

type LoadState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; items: SessionListItem[]; nextCursor: string | null; loadingMore: boolean };

export function ConversationsList({ agentId, apiBase }: ConversationsListProps) {
	const [state, setState] = useState<LoadState>({ kind: "loading" });

	const fetchPage = useCallback(
		async (cursor: string | null, signal: AbortSignal): Promise<ListSessionsResponse> => {
			const base = apiBase ?? window.location.origin;
			const url = new URL("/v1/sessions", base);
			if (agentId !== undefined) url.searchParams.set("agentId", agentId);
			if (cursor !== null) url.searchParams.set("cursor", cursor);
			const res = await fetch(url, { signal });
			if (!res.ok) throw new SessionsLoadError(res.status);
			// `safeParse` per boundary-validation.md §4: schema failure becomes a
			// typed slice error, not a raw ValiError that callers must `instanceof`-check.
			const parsed = v.safeParse(ListSessionsResponseSchema, await res.json());
			if (!parsed.success) throw new SessionsInvalidResponseError(parsed.issues);
			return parsed.output;
		},
		[agentId, apiBase],
	);

	// Single load helper shared by the initial-mount effect and the Try again
	// button. Returns an abort callback so the effect can cancel the in-flight
	// fetch on unmount and the button can call it directly.
	const reload = useCallback((): (() => void) => {
		const controller = new AbortController();
		setState({ kind: "loading" });
		fetchPage(null, controller.signal)
			.then((page) => {
				setState({
					kind: "ready",
					items: page.sessions,
					nextCursor: page.nextCursor,
					loadingMore: false,
				});
			})
			.catch((e: unknown) => {
				if (controller.signal.aborted) return;
				setState({ kind: "error", message: errorMessage(e) });
			});
		return () => controller.abort();
	}, [fetchPage]);

	useEffect(() => reload(), [reload]);

	const loadMore = useCallback(() => {
		if (state.kind !== "ready" || state.nextCursor === null || state.loadingMore) return;
		const cursor = state.nextCursor;
		setState((prev) => (prev.kind === "ready" ? { ...prev, loadingMore: true } : prev));
		// loadMore's fetch isn't aborted on unmount: an in-flight append that
		// completes after a navigation away is benign — React drops the setState
		// on an unmounted component. The initial fetch IS aborted because the
		// effect cleanup is the only way to cancel it before completion.
		fetchPage(cursor, new AbortController().signal)
			.then((page) => {
				setState((prev) =>
					prev.kind === "ready"
						? {
								kind: "ready",
								items: [...prev.items, ...page.sessions],
								nextCursor: page.nextCursor,
								loadingMore: false,
							}
						: prev,
				);
			})
			.catch((e: unknown) => {
				setState((prev) =>
					prev.kind === "ready" ? { kind: "error", message: errorMessage(e) } : prev,
				);
			});
	}, [state, fetchPage]);

	return (
		<aside aria-label="Conversations" aria-busy={state.kind === "loading"}>
			{match(state)
				.with({ kind: "loading" }, () => <p>Loading sessions…</p>)
				.with({ kind: "error" }, (s) => (
					<>
						<p role="alert">Failed to load sessions: {s.message}</p>
						<button type="button" onClick={() => reload()}>
							Try again
						</button>
					</>
				))
				.with({ kind: "ready" }, (s) =>
					s.items.length === 0 ? (
						<EmptyState />
					) : (
						<>
							<ul>
								{s.items.map((item) => (
									<ConversationRow key={item.id} session={item} />
								))}
							</ul>
							{s.nextCursor !== null && (
								<button type="button" onClick={loadMore} disabled={s.loadingMore}>
									{s.loadingMore ? "Loading…" : "Load more"}
								</button>
							)}
						</>
					),
				)
				.exhaustive()}
		</aside>
	);
}

interface ConversationRowProps {
	session: SessionListItem;
}

function ConversationRow({ session }: ConversationRowProps) {
	return (
		<li>
			<time dateTime={session.startedAt}>{formatStartedAt(session.startedAt)}</time>
			<dl>
				<dt>Agent</dt>
				<dd>{session.agentId}</dd>
				<dt>Duration</dt>
				<dd>{formatDuration(session.durationMs)}</dd>
				<dt>Source</dt>
				<dd>{session.source}</dd>
			</dl>
		</li>
	);
}

function EmptyState() {
	return (
		<>
			<p>No sessions yet.</p>
			<p>To populate the store:</p>
			<ul>
				<li>
					Run <code>pnpm dev:seed</code> to load JSONL fixtures.
				</li>
				<li>
					POST events from your voice-agent loop to <code>/v1/sessions/:id/events</code>.
				</li>
				<li>
					Or configure a provider adapter (e.g. <code>ELEVENLABS_API_KEY</code>).
				</li>
			</ul>
		</>
	);
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : "Unknown error";
}

function formatStartedAt(iso: string): string {
	return new Date(iso).toLocaleString();
}

function formatDuration(ms: number | null): string {
	if (ms === null) return "in progress";
	if (ms < 1000) return `${ms}ms`;
	const secs = Math.round(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const m = Math.floor(secs / 60);
	const s = secs % 60;
	return `${m}m${s.toString().padStart(2, "0")}s`;
}
