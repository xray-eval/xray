import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { replayEventsUrl } from "@/client/api/api.ts";
import type { ReplayLifecycleState } from "@/server/store/types.ts";

/**
 * Stream the replay's server-sent events while it's still progressing and
 * invalidate its cached queries on every transition — so a replay opened
 * mid-analysis advances live (analysis step, verdict, transcripts, metrics)
 * instead of staying frozen until a manual reload.
 *
 * This is a legitimate `useEffect`: it synchronizes the React Query cache with
 * an external system (the browser `EventSource`), per the client
 * `no-effect-for-data` rule. Terminal replays never change again, so the stream
 * is opened only while non-terminal, and the effect tears it down the moment
 * the lifecycle flips to completed/failed.
 */
export function useReplayLiveUpdates(replayId: string, lifecycleState: ReplayLifecycleState): void {
	const queryClient = useQueryClient();
	const isTerminal = lifecycleState === "completed" || lifecycleState === "failed";
	useEffect(() => {
		if (isTerminal) return;
		const source = new EventSource(replayEventsUrl(replayId));
		// Any state/verdict/failure transition can change the cached replay row
		// (and, once completed, its evaluation result). Invalidating the
		// `["replays", { id }]` prefix refetches both the detail and the result
		// query. `progress` events fire often and don't change row shape, so
		// they're intentionally left unsubscribed to avoid a refetch storm.
		const invalidate = () => {
			void queryClient.invalidateQueries({ queryKey: ["replays", { id: replayId }] });
		};
		source.addEventListener("state", invalidate);
		source.addEventListener("evaluation_complete", invalidate);
		source.addEventListener("failed", invalidate);
		return () => source.close();
	}, [replayId, isTerminal, queryClient]);
}
