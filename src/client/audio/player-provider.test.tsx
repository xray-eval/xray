import { registerHappyDom } from "../test-happy-dom.ts";
import { PlayerProviderMissingError } from "./player-provider.errors.ts";
import type { PlayerControls, PlayheadState } from "./player-provider.tsx";
import {
	PlayerProvider,
	usePlayer,
	usePlayhead,
	usePublishPlayhead,
	useRegisterPlayer,
} from "./player-provider.tsx";
import { describe, expect, it } from "bun:test";

registerHappyDom();
const { act, cleanup, render, renderHook, screen } = await import("@testing-library/react");
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

describe("usePlayhead / usePublishPlayhead", () => {
	it("throws PlayerProviderMissingError when usePlayhead is called outside the provider", () => {
		expect(() => renderHook(() => usePlayhead())).toThrow(PlayerProviderMissingError);
	});

	it("starts at sec=0 / playing=false before anything is published", () => {
		const { result } = renderHook(() => usePlayhead(), { wrapper });
		expect(result.current).toEqual({ sec: 0, playing: false });
	});

	it("reflects the latest published playhead value", () => {
		const { result } = renderHook(
			() => ({ publish: usePublishPlayhead(), playhead: usePlayhead() }),
			{ wrapper },
		);
		expect(result.current.playhead).toEqual({ sec: 0, playing: false });

		act(() => {
			result.current.publish({ sec: 1.5, playing: true });
		});
		expect(result.current.playhead).toEqual({ sec: 1.5, playing: true });

		act(() => {
			result.current.publish({ sec: 4.25, playing: false });
		});
		expect(result.current.playhead).toEqual({ sec: 4.25, playing: false });
	});

	it("publishing is a no-op (no throw) when called outside a provider", () => {
		const { result } = renderHook(() => usePublishPlayhead());
		expect(() => result.current({ sec: 2, playing: true })).not.toThrow();
	});

	it("stops updating a consumer once it unmounts, without affecting siblings", () => {
		let publish: (state: PlayheadState) => void = () => undefined;
		function Publisher() {
			publish = usePublishPlayhead();
			return null;
		}
		function Readout({ id }: { id: string }) {
			const { sec } = usePlayhead();
			return <span data-testid={id}>{sec}</span>;
		}
		function Tree({ showB }: { showB: boolean }) {
			return (
				<PlayerProvider>
					<Publisher />
					<Readout id="a" />
					{showB && <Readout id="b" />}
				</PlayerProvider>
			);
		}
		const { rerender } = render(<Tree showB={true} />);
		act(() => publish({ sec: 1, playing: true }));
		expect(screen.getByTestId("a").textContent).toBe("1");
		expect(screen.getByTestId("b").textContent).toBe("1");

		rerender(<Tree showB={false} />);
		expect(screen.queryByTestId("b")).toBeNull();

		// The unmounted consumer's listener must have been cleaned up: publishing
		// again updates the surviving consumer and never touches the gone one.
		act(() => publish({ sec: 2, playing: false }));
		expect(screen.getByTestId("a").textContent).toBe("2");
	});
});
