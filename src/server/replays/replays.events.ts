import type { AnalysisStep, ReplayLifecycleState } from "@/server/store/types.ts";

export interface ReplayStateEvent {
	readonly type: "state";
	readonly lifecycle_state: ReplayLifecycleState;
	readonly analysis_step: AnalysisStep | null;
}

export interface ReplayProgressEvent {
	readonly type: "progress";
	readonly percent: number;
	readonly step: string | null;
}

export interface ReplayCompletedEvent {
	readonly type: "completed";
	readonly turns_written: number;
	readonly segments_written: number;
}

export interface ReplayFailedEvent {
	readonly type: "failed";
	readonly reason: string;
}

export type ReplayEvent =
	| ReplayStateEvent
	| ReplayProgressEvent
	| ReplayCompletedEvent
	| ReplayFailedEvent;

type Listener = (event: ReplayEvent) => void;

/**
 * Per-replay pub/sub for SSE consumers. Listeners are added on connection
 * and removed on client disconnect. The dispatcher runs the listener
 * synchronously; the listener itself decides whether to enqueue the event
 * onto the streaming response.
 */
export class ReplayEvents {
	private readonly listeners = new Map<string, Set<Listener>>();

	emit(replayId: string, event: ReplayEvent): void {
		const set = this.listeners.get(replayId);
		if (set === undefined) return;
		for (const fn of set) fn(event);
	}

	subscribe(replayId: string, listener: Listener): () => void {
		let set = this.listeners.get(replayId);
		if (set === undefined) {
			set = new Set();
			this.listeners.set(replayId, set);
		}
		set.add(listener);
		return () => {
			const s = this.listeners.get(replayId);
			if (s === undefined) return;
			s.delete(listener);
			if (s.size === 0) this.listeners.delete(replayId);
		};
	}

	/** Test helper — how many listeners are currently attached to `replayId`. */
	listenerCount(replayId: string): number {
		return this.listeners.get(replayId)?.size ?? 0;
	}
}

export function makeReplayEvents(): ReplayEvents {
	return new ReplayEvents();
}
