import type { ReplayDetailResponse } from "../../api/api.types.ts";
import { registerHappyDom } from "../../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen } = await import("@testing-library/react");
const { AnalysisProgress } = await import("./analysis-progress.tsx");

afterEach(() => cleanup());

function buildReplay(overrides: Partial<ReplayDetailResponse> = {}): ReplayDetailResponse {
	return {
		id: "44444444-4444-4444-4444-444444444444",
		conversation_hash: "a".repeat(64),
		lifecycle_state: "analyzing",
		analysis_step: "transcribe",
		failure_reason: null,
		started_at: "2026-05-15T10:00:00.000Z",
		finished_at: null,
		audio_path: "/data/audio/replay.wav",
		job_id: "job-1",
		run_config: null,
		turns: [],
		speech_segments: [],
		transcripts: [],
		turn_metrics: [],
		tool_calls: [],
		model_usage: [],
		spans: [],
		...overrides,
	};
}

describe("AnalysisProgress", () => {
	it("renders the stage chain and marks the current step active", () => {
		render(<AnalysisProgress replay={buildReplay({ analysis_step: "transcribe" })} />);
		expect(screen.getByRole("status")).toBeTruthy();
		expect(screen.getByText("Detecting turns")).toBeTruthy();
		expect(screen.getByText("Evaluating")).toBeTruthy();
		const active = screen.getByText("Transcribing").closest("[aria-current]");
		expect(active?.getAttribute("aria-current")).toBe("step");
	});

	it("renders nothing once the replay is no longer analyzing", () => {
		const { container } = render(
			<AnalysisProgress
				replay={buildReplay({ lifecycle_state: "completed", analysis_step: null })}
			/>,
		);
		expect(container.textContent).toBe("");
	});
});
