import type { ReplayTurnResponse, SpanResponse } from "@/client/api/api.types.ts";
import type { PlayerControls, PlayheadState } from "@/client/audio/player-provider.tsx";
import {
	PlayerProvider,
	usePublishPlayhead,
	useRegisterPlayer,
} from "@/client/audio/player-provider.tsx";

import { registerHappyDom } from "../test-happy-dom.ts";
import { SpanSelectionProvider, useSpanSelection } from "./span-selection.tsx";
import { fractionOf, playheadLeft, TraceTree } from "./trace-tree.tsx";
import type { TraceScale } from "./trace-tree.types.ts";
import { describe, expect, it } from "bun:test";

registerHappyDom();
const { act, cleanup, render, screen } = await import("@testing-library/react");
const { afterEach } = await import("bun:test");

afterEach(() => cleanup());

const REPLAY_START = "2026-05-25T10:00:00.000Z";
const REPLAY_START_MS = Date.parse(REPLAY_START);

function turn(
	idx: number,
	role: "user" | "agent",
	startMs: number,
	endMs: number,
): ReplayTurnResponse {
	return {
		idx,
		role,
		turn_start_ms: startMs,
		turn_end_ms: endMs,
		voice_start_ms: startMs,
		voice_end_ms: endMs,
	};
}

function span(
	id: number,
	name: string,
	offsetStartMs: number,
	offsetEndMs: number,
	parentSpanId: string | null = null,
): SpanResponse {
	return {
		id,
		trace_id: "trace",
		span_id: `s-${id}`,
		parent_span_id: parentSpanId,
		name,
		vocabulary: "xray",
		started_at: new Date(REPLAY_START_MS + offsetStartMs).toISOString(),
		ended_at: new Date(REPLAY_START_MS + offsetEndMs).toISOString(),
		attributes_json: "{}",
	};
}

describe("TraceTree", () => {
	it("renders the empty state when there are no spans", () => {
		render(
			<PlayerProvider>
				<TraceTree turns={[]} spans={[]} replayStartIso={REPLAY_START} zoom={1} />
			</PlayerProvider>,
		);
		expect(screen.getByText(/No spans recorded/i)).toBeTruthy();
	});

	it("renders turn rows when turns exist but no spans were emitted", () => {
		render(
			<PlayerProvider>
				<TraceTree
					turns={[turn(0, "user", 0, 2_500), turn(1, "agent", 3_000, 6_500)]}
					spans={[]}
					replayStartIso={REPLAY_START}
					zoom={1}
				/>
			</PlayerProvider>,
		);
		expect(screen.getByLabelText(/Seek to turn 1, user/i)).toBeTruthy();
		expect(screen.getByLabelText(/Seek to turn 2, agent/i)).toBeTruthy();
		expect(screen.queryByText(/No spans recorded/i)).toBeNull();
	});

	it("renders one row per turn and per attributed span", () => {
		render(
			<PlayerProvider>
				<TraceTree
					turns={[turn(0, "user", 0, 2_500), turn(1, "agent", 3_000, 6_500)]}
					spans={[span(1, "stt.transcribe", 200, 1_400)]}
					replayStartIso={REPLAY_START}
					zoom={1}
				/>
			</PlayerProvider>,
		);
		expect(screen.getByLabelText(/Seek to turn 1, user/i)).toBeTruthy();
		expect(screen.getByLabelText(/Seek to turn 2, agent/i)).toBeTruthy();
		expect(screen.getByLabelText(/Inspect xray span stt\.transcribe$/i)).toBeTruthy();
	});

	it("clicking a span row seeks the player to its relative start time", () => {
		const seeks: number[] = [];
		const highlights: [number, number][] = [];
		const clears: number[] = [];
		const controls: PlayerControls = {
			seek: (s) => seeks.push(s),
			highlight: (a, b) => highlights.push([a, b]),
			clearHighlight: () => clears.push(1),
		};
		function Register() {
			useRegisterPlayer(controls);
			return null;
		}
		render(
			<PlayerProvider>
				<Register />
				<TraceTree
					turns={[turn(0, "user", 0, 2_500)]}
					spans={[span(1, "stt.transcribe", 750, 1_400)]}
					replayStartIso={REPLAY_START}
					zoom={1}
				/>
			</PlayerProvider>,
		);
		act(() => {
			screen.getByLabelText(/Inspect xray span stt\.transcribe$/i).click();
		});
		expect(seeks).toEqual([0.75]);
		expect(highlights).toEqual([[0.75, 1.4]]);
	});

	it("collapsing a turn hides its descendant span rows", () => {
		render(
			<PlayerProvider>
				<TraceTree
					turns={[turn(0, "user", 0, 2_500)]}
					spans={[span(1, "tool_call", 200, 1_400), span(2, "rag_retrieve", 300, 800, "s-1")]}
					replayStartIso={REPLAY_START}
					zoom={1}
				/>
			</PlayerProvider>,
		);
		expect(screen.getByLabelText(/Inspect xray span tool_call$/i)).toBeTruthy();
		expect(screen.getByLabelText(/Inspect xray span rag_retrieve$/i)).toBeTruthy();
		act(() => {
			const collapseBtn = screen.getAllByRole("button", { name: /Collapse/i }).at(0);
			collapseBtn?.click();
		});
		expect(screen.queryByLabelText(/Inspect xray span tool_call$/i)).toBeNull();
		expect(screen.queryByLabelText(/Inspect xray span rag_retrieve$/i)).toBeNull();
	});

	it("renders the Untimed group when a span sits outside every turn", () => {
		render(
			<PlayerProvider>
				<TraceTree
					turns={[turn(0, "user", 0, 2_500)]}
					spans={[span(1, "setup", -1_000, -500)]}
					replayStartIso={REPLAY_START}
					zoom={1}
				/>
			</PlayerProvider>,
		);
		expect(screen.getByText(/Untimed/)).toBeTruthy();
	});

	it("renders time ruler ticks", () => {
		render(
			<PlayerProvider>
				<TraceTree
					turns={[turn(0, "user", 0, 6_000)]}
					spans={[span(1, "stt", 100, 1_000)]}
					replayStartIso={REPLAY_START}
					zoom={1}
				/>
			</PlayerProvider>,
		);
		expect(screen.getByText(/Span \/ call/i)).toBeTruthy();
	});
});

describe("TraceTree selection", () => {
	function SelectionReadout() {
		const { selectedSpanId } = useSpanSelection();
		return <output data-testid="selected">{selectedSpanId ?? "none"}</output>;
	}

	it("clicking a span selects it and marks the row aria-current", () => {
		render(
			<PlayerProvider>
				<SpanSelectionProvider>
					<SelectionReadout />
					<TraceTree
						turns={[turn(0, "user", 0, 2_500)]}
						spans={[span(1, "stt.transcribe", 750, 1_400)]}
						replayStartIso={REPLAY_START}
						zoom={1}
					/>
				</SpanSelectionProvider>
			</PlayerProvider>,
		);
		const row = screen.getByLabelText(/Inspect xray span stt\.transcribe$/i);
		expect(row.getAttribute("aria-current")).toBeNull();
		act(() => row.click());
		expect(screen.getByTestId("selected").textContent).toBe("s-1");
		expect(
			screen.getByLabelText(/Inspect xray span stt\.transcribe$/i).getAttribute("aria-current"),
		).toBe("true");
	});
});

describe("fractionOf", () => {
	const scale: TraceScale = { startSec: 0, endSec: 10, durationSec: 10 };

	it("maps start/mid/end to 0 / 0.5 / 1", () => {
		expect(fractionOf(0, scale)).toBe(0);
		expect(fractionOf(5, scale)).toBe(0.5);
		expect(fractionOf(10, scale)).toBe(1);
	});

	it("honors a non-zero scale origin", () => {
		expect(fractionOf(7, { startSec: 2, endSec: 12, durationSec: 10 })).toBe(0.5);
	});

	it("clamps below the start and above the end", () => {
		expect(fractionOf(-4, scale)).toBe(0);
		expect(fractionOf(15, scale)).toBe(1);
	});

	it("returns 0 for a degenerate (zero-duration / non-finite) scale", () => {
		expect(fractionOf(5, { startSec: 0, endSec: 0, durationSec: 0 })).toBe(0);
	});
});

describe("playheadLeft", () => {
	// 280 == STICKY_LEFT_TOTAL_PX (the fixed label columns). The cursor lives in
	// the timeline region after them; `100%` resolves to the zoomed virtual
	// width at runtime, so the same expression tracks any zoom level.
	it("maps a fraction onto the timeline region after the sticky columns", () => {
		expect(playheadLeft(0)).toBe("calc(280px + 0 * (100% - 280px))");
		expect(playheadLeft(0.5)).toBe("calc(280px + 0.5 * (100% - 280px))");
		expect(playheadLeft(1)).toBe("calc(280px + 1 * (100% - 280px))");
	});
});

describe("TracePlayhead", () => {
	const SINGLE_TURN = [turn(0, "agent", 0, 10_000)]; // scale → { 0, 10, 10 }

	function renderWithDriver(zoom: number) {
		const noop = () => undefined;
		let publish: (state: PlayheadState) => void = noop;
		const controls: PlayerControls = {
			seek: noop,
			highlight: noop,
			clearHighlight: noop,
		};
		function Driver() {
			useRegisterPlayer(controls);
			publish = usePublishPlayhead();
			return null;
		}
		render(
			<PlayerProvider>
				<Driver />
				<TraceTree turns={SINGLE_TURN} spans={[]} replayStartIso={REPLAY_START} zoom={zoom} />
			</PlayerProvider>,
		);
		return (state: PlayheadState) => act(() => publish(state));
	}

	it("renders no cursor when the player is not ready (no audio)", () => {
		render(
			<PlayerProvider>
				<TraceTree turns={SINGLE_TURN} spans={[]} replayStartIso={REPLAY_START} zoom={1} />
			</PlayerProvider>,
		);
		expect(screen.queryByTestId("trace-playhead")).toBeNull();
	});

	// The exact `left` math lives in the `playheadLeft` / `fractionOf` unit
	// tests above — happy-dom's CSSOM can't represent a `calc(… * …)` value, so
	// asserting `.style.left` here would read back empty. These cases cover the
	// wiring: the published `sec` flows into the cursor and its clock pill.
	it("appears once the player is ready and shows the live playback clock", () => {
		const publish = renderWithDriver(1);
		publish({ sec: 5, playing: true });
		expect(screen.getByTestId("trace-playhead")).toBeTruthy();
		expect(screen.getByText("0:05.0")).toBeTruthy();
	});

	it("is decorative: aria-hidden and pointer-events-none so it never steals seek clicks", () => {
		const publish = renderWithDriver(1);
		publish({ sec: 5, playing: true });
		const cursor = screen.getByTestId("trace-playhead");
		expect(cursor.getAttribute("aria-hidden")).toBe("true");
		expect(cursor.className).toContain("pointer-events-none");
	});
});
