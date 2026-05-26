import { registerHappyDom } from "../test-happy-dom.ts";
import { PlayerProviderMissingError } from "./player-provider.errors.ts";
import type { PlayerControls } from "./player-provider.tsx";
import { PlayerProvider, usePlayer, useRegisterPlayer } from "./player-provider.tsx";
import { describe, expect, it } from "bun:test";

registerHappyDom();
const { act, cleanup, renderHook } = await import("@testing-library/react");
const { afterEach } = await import("bun:test");

afterEach(() => cleanup());

function wrapper({ children }: { children: React.ReactNode }) {
	return <PlayerProvider>{children}</PlayerProvider>;
}

describe("usePlayer", () => {
	it("throws PlayerProviderMissingError when called outside the provider", () => {
		expect(() => renderHook(() => usePlayer())).toThrow(PlayerProviderMissingError);
	});

	it("returns isReady=false and no-op seek/highlight when no controls are registered", () => {
		const { result } = renderHook(() => usePlayer(), { wrapper });
		expect(result.current.isReady).toBe(false);
		expect(() => result.current.seek(1.5)).not.toThrow();
		expect(() => result.current.highlight(0, 1)).not.toThrow();
	});

	it("delegates seek and highlight to the registered controls and flips isReady", () => {
		const seeks: number[] = [];
		const highlights: [number, number][] = [];
		const clears: number[] = [];
		const controls: PlayerControls = {
			seek: (s) => seeks.push(s),
			highlight: (a, b) => highlights.push([a, b]),
			clearHighlight: () => clears.push(1),
		};

		const { result } = renderHook(
			() => {
				useRegisterPlayer(controls);
				return usePlayer();
			},
			{ wrapper },
		);

		expect(result.current.isReady).toBe(true);

		act(() => {
			result.current.seek(2.5);
			result.current.highlight(3, 4.25);
			result.current.clearHighlight();
		});

		expect(seeks).toEqual([2.5]);
		expect(highlights).toEqual([[3, 4.25]]);
		expect(clears).toEqual([1]);
	});

	it("flips isReady back to false when registered controls are removed", () => {
		const calls: string[] = [];
		const controls: PlayerControls = {
			seek: () => calls.push("seek"),
			highlight: () => calls.push("highlight"),
			clearHighlight: () => calls.push("clear"),
		};
		const { result, rerender } = renderHook(
			({ active }: { active: boolean }) => {
				useRegisterPlayer(active ? controls : null);
				return usePlayer();
			},
			{ wrapper, initialProps: { active: true } },
		);
		expect(result.current.isReady).toBe(true);
		rerender({ active: false });
		expect(result.current.isReady).toBe(false);
	});
});
