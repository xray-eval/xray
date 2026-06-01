import { registerHappyDom } from "../test-happy-dom.ts";
import { PlayerProvider, usePlayhead } from "./player-provider.tsx";
import type { WavesurferPlayheadSource } from "./wavesurfer-playhead.ts";
import { usePublishWavesurferPlayhead } from "./wavesurfer-playhead.ts";
import { describe, expect, it } from "bun:test";

registerHappyDom();
const { act, cleanup, renderHook } = await import("@testing-library/react");
const { afterEach } = await import("bun:test");

afterEach(() => cleanup());

type WaveEvent = "timeupdate" | "play" | "pause";

function makeFakeWavesurfer() {
	const handlers: Record<WaveEvent, Set<() => void>> = {
		timeupdate: new Set(),
		play: new Set(),
		pause: new Set(),
	};
	let time = 0;
	let playing = false;
	const source: WavesurferPlayheadSource = {
		getCurrentTime: () => time,
		isPlaying: () => playing,
		on: (event, listener) => {
			handlers[event].add(listener);
			return () => {
				handlers[event].delete(listener);
			};
		},
	};
	return {
		source,
		listenerCount: () => handlers.timeupdate.size + handlers.play.size + handlers.pause.size,
		fire: (event: WaveEvent, next: { sec?: number; playing?: boolean }) => {
			if (next.sec !== undefined) time = next.sec;
			if (next.playing !== undefined) playing = next.playing;
			for (const h of handlers[event]) h();
		},
	};
}

function wrapper({ children }: { children: React.ReactNode }) {
	return <PlayerProvider>{children}</PlayerProvider>;
}

describe("usePublishWavesurferPlayhead", () => {
	it("publishes position from timeupdate and playing-state from play/pause", () => {
		const ws = makeFakeWavesurfer();
		const { result } = renderHook(
			() => {
				usePublishWavesurferPlayhead(ws.source);
				return usePlayhead();
			},
			{ wrapper },
		);
		expect(result.current).toEqual({ sec: 0, playing: false });

		act(() => ws.fire("play", { sec: 0, playing: true }));
		expect(result.current).toEqual({ sec: 0, playing: true });

		act(() => ws.fire("timeupdate", { sec: 2.5, playing: true }));
		expect(result.current).toEqual({ sec: 2.5, playing: true });

		act(() => ws.fire("pause", { sec: 2.5, playing: false }));
		expect(result.current).toEqual({ sec: 2.5, playing: false });
	});

	it("subscribes to exactly the three clock events and unsubscribes on unmount", () => {
		const ws = makeFakeWavesurfer();
		const { unmount } = renderHook(() => usePublishWavesurferPlayhead(ws.source), {
			wrapper,
		});
		expect(ws.listenerCount()).toBe(3);
		unmount();
		expect(ws.listenerCount()).toBe(0);
	});

	it("is a no-op while the source is null (player not yet ready)", () => {
		const { result } = renderHook(
			() => {
				usePublishWavesurferPlayhead(null);
				return usePlayhead();
			},
			{ wrapper },
		);
		expect(result.current).toEqual({ sec: 0, playing: false });
	});
});
