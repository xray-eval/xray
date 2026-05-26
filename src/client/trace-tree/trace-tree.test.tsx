import type { ReplayTurnResponse, SpanResponse } from "@/client/api/api.types.ts";
import type { PlayerControls } from "@/client/audio/player-provider.tsx";
import { PlayerProvider, useRegisterPlayer } from "@/client/audio/player-provider.tsx";

import { registerHappyDom } from "../test-happy-dom.ts";
import { TraceTree } from "./trace-tree.tsx";
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
		expect(screen.getByLabelText(/Seek to xray span stt\.transcribe$/i)).toBeTruthy();
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
			screen.getByLabelText(/Seek to xray span stt\.transcribe$/i).click();
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
		expect(screen.getByLabelText(/Seek to xray span tool_call$/i)).toBeTruthy();
		expect(screen.getByLabelText(/Seek to xray span rag_retrieve$/i)).toBeTruthy();
		act(() => {
			const collapseBtn = screen.getAllByRole("button", { name: /Collapse/i }).at(0);
			collapseBtn?.click();
		});
		expect(screen.queryByLabelText(/Seek to xray span tool_call$/i)).toBeNull();
		expect(screen.queryByLabelText(/Seek to xray span rag_retrieve$/i)).toBeNull();
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
