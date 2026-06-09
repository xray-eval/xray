import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import type { ReplayResult } from "../../api/api.types.ts";
import { registerHappyDom } from "../../test-happy-dom.ts";
import {
	makeAssertionOutcome,
	makeJudgeOutcome,
	makeReplayResult,
	makeTurnMetrics,
} from "./evaluation.test-utils.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { withQueryClient } = await import("../../test-utils.tsx");
const { EvaluationPanel } = await import("./evaluation.tsx");

afterEach(() => cleanup());

const REPLAY_ID = "44444444-4444-4444-4444-444444444444";

function mockResult(result: ReplayResult) {
	server.use(
		http.get(`http://localhost/v1/replays/${REPLAY_ID}/result`, () => HttpResponse.json(result)),
	);
}

function renderPanel(lifecycleState: "completed" | "analyzing" = "completed") {
	render(withQueryClient(<EvaluationPanel replayId={REPLAY_ID} lifecycleState={lifecycleState} />));
}

describe("EvaluationPanel verdict", () => {
	it("renders a Passed verdict with the assertion tally", async () => {
		mockResult(
			makeReplayResult({
				passed: true,
				assertions: [
					makeAssertionOutcome({
						turn_idx: 1,
						assertion_idx: 0,
						kind: "contains",
						status: "passed",
					}),
				],
			}),
		);
		renderPanel();

		await waitFor(() => screen.getByText("Passed"));
		expect(screen.getByText("assertions")).toBeTruthy();
		// The bar names each check by kind even while collapsed…
		expect(screen.getByText("contains")).toBeTruthy();
		// …but the per-turn breakdown stays collapsed until expanded.
		expect(screen.queryByText(/Turn 1/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /details/i }));
		expect(screen.getByText(/Turn 1/)).toBeTruthy();
	});

	it("renders a Failed verdict and surfaces the failing assertion message", async () => {
		mockResult(
			makeReplayResult({
				passed: false,
				assertions: [
					makeAssertionOutcome({
						turn_idx: 1,
						status: "failed",
						kind: "contains",
						message: "expected transcript to contain 'refund'",
					}),
				],
			}),
		);
		renderPanel();

		await waitFor(() => screen.getByText("Failed"));
		expect(screen.getByText(/expected transcript to contain 'refund'/)).toBeTruthy();
		// The outcome bar is labeled "Checks" with a color legend so it reads as
		// per-check results, not steps.
		expect(screen.getByText(/Checks/)).toBeTruthy();
		expect(screen.getByText(/1 failed/)).toBeTruthy();
	});

	it("renders a neutral verdict when no assertions or judges were declared", async () => {
		mockResult(
			makeReplayResult({ passed: true, metrics: { turns: [makeTurnMetrics({ turn_idx: 0 })] } }),
		);
		renderPanel();

		await waitFor(() => screen.getByText("No verdict"));
		expect(screen.getByText(/No assertions or judges declared for this conversation/)).toBeTruthy();
	});
});

describe("EvaluationPanel judges", () => {
	it("renders a judge score and reason", async () => {
		mockResult(
			makeReplayResult({
				passed: true,
				judges: [
					makeJudgeOutcome({
						kind: "text_match",
						status: "passed",
						score: 88,
						reason: "The agent confirmed the booking and read back the date.",
					}),
				],
			}),
		);
		renderPanel();

		// Passed → collapsed; expand to reveal the judge breakdown. The score and
		// reason live only in that breakdown (the bar just names the kind).
		await waitFor(() => screen.getByText("Passed"));
		fireEvent.click(screen.getByRole("button", { name: /details/i }));
		expect(screen.getByText("88")).toBeTruthy();
		expect(screen.getByText(/confirmed the booking/)).toBeTruthy();
	});
});

describe("EvaluationPanel gating", () => {
	it("renders nothing until the replay has completed", () => {
		renderPanel("analyzing");
		expect(screen.queryByText("Passed")).toBeNull();
		expect(screen.queryByText("No verdict")).toBeNull();
	});
});

describe("EvaluationPanel errors", () => {
	it("renders an unavailable notice when the result fetch fails", async () => {
		server.use(
			http.get(`http://localhost/v1/replays/${REPLAY_ID}/result`, () =>
				HttpResponse.json({ error: "boom" }, { status: 500 }),
			),
		);
		renderPanel();
		const alert = await waitFor(() => screen.getByRole("alert"));
		expect(alert.textContent).toMatch(/Evaluation result is unavailable/i);
	});

	it("marks an errored assertion with the warning glyph, distinct from failed", async () => {
		mockResult(
			makeReplayResult({
				passed: false,
				assertions: [
					makeAssertionOutcome({
						turn_idx: 0,
						status: "errored",
						kind: "tool_called",
						message: "tool-call lookup threw",
					}),
				],
			}),
		);
		renderPanel();

		// passed=false auto-expands the breakdown, so the per-assertion glyph
		// renders without a click. `errored` is the warning triangle.
		await waitFor(() => screen.getByText("Failed"));
		expect(screen.getByLabelText("errored")).toBeTruthy();
		expect(screen.getByText(/tool-call lookup threw/)).toBeTruthy();
	});
});
