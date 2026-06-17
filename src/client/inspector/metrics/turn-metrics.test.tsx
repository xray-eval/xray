import type { TurnMetricsResponse } from "../../api/api.types.ts";
import { registerHappyDom } from "../../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen } = await import("@testing-library/react");
const { TurnMetricsSection } = await import("./turn-metrics.tsx");

afterEach(() => cleanup());

function turn(overrides: Partial<TurnMetricsResponse>): TurnMetricsResponse {
	return {
		turn_idx: 0,
		role: "agent",
		agent_response_ms: 250,
		interrupted: false,
		interruption_start_ms: null,
		...overrides,
	};
}

describe("TurnMetricsSection", () => {
	it("renders a row per turn with the response timing", () => {
		render(
			<TurnMetricsSection
				turns={[
					turn({ turn_idx: 0, role: "user", agent_response_ms: null }),
					turn({ turn_idx: 1, role: "agent", agent_response_ms: 2430 }),
				]}
			/>,
		);
		expect(screen.getByText("Per-turn metrics")).toBeTruthy();
		expect(screen.getByText("T01")).toBeTruthy();
		// formatDurationMs renders ≥1000ms as seconds, sub-second as ms.
		expect(screen.getByText("2.43s")).toBeTruthy();
	});

	it("shows the barge-in time as a clock for an interrupted turn", () => {
		render(
			<TurnMetricsSection
				turns={[turn({ turn_idx: 1, interrupted: true, interruption_start_ms: 4200 })]}
			/>,
		);
		expect(screen.getByText("0:04.2")).toBeTruthy();
	});

	it("renders nothing when there are no turns", () => {
		const { container } = render(<TurnMetricsSection turns={[]} />);
		expect(container.textContent).toBe("");
	});
});
