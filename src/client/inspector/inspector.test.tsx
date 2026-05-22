import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import type { ReplayDetailResponse } from "../api/api.types.ts";
import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");

afterEach(() => cleanup());

const REPLAY_ID = "44444444-4444-4444-4444-444444444444";

function buildReplay(overrides: Partial<ReplayDetailResponse> = {}): ReplayDetailResponse {
	return {
		id: REPLAY_ID,
		conversation_hash: "a".repeat(64),
		lifecycle_state: "completed",
		analysis_step: null,
		failure_reason: null,
		started_at: "2026-05-15T10:00:00.000Z",
		finished_at: "2026-05-15T10:00:30.000Z",
		audio_path: null,
		job_id: null,
		run_config: null,
		turns: [
			{
				idx: 0,
				role: "user",
				turn_start_ms: 0,
				turn_end_ms: 2500,
				voice_start_ms: 100,
				voice_end_ms: 2400,
			},
			{
				idx: 1,
				role: "agent",
				turn_start_ms: 3000,
				turn_end_ms: 6500,
				voice_start_ms: 3100,
				voice_end_ms: 6400,
			},
		],
		speech_segments: [],
		tool_calls: [],
		model_usage: [],
		spans: [],
		...overrides,
	};
}

function mockReplay(replay: ReplayDetailResponse) {
	server.use(http.get(`http://localhost/v1/replays/${replay.id}`, () => HttpResponse.json(replay)));
}

describe("Inspector empty states", () => {
	it("renders the @xray.trace copy when the replay has no spans", async () => {
		mockReplay(buildReplay({ spans: [] }));
		const { ui } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		const empty = await waitFor(() => screen.getByText(/No trace spans recorded/i));
		expect(empty.textContent).toMatch(/@xray\.trace\.stage/);
		expect(empty.textContent).toMatch(/docs\/SDK\.md/);
	});

	it("explains that VAD populates the Turns card when none have been derived", async () => {
		mockReplay(buildReplay({ turns: [] }));
		const { ui } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		const empty = await waitFor(() => screen.getByText(/No turns derived yet/i));
		expect(empty.textContent).toMatch(/VAD analysis/);
	});
});

describe("Inspector header", () => {
	it("shows the lifecycle state as a status badge", async () => {
		mockReplay(buildReplay({ lifecycle_state: "failed", failure_reason: "driver_aborted" }));
		const { ui } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		const badge = await waitFor(() => screen.getByLabelText(/failed: driver_aborted/i));
		expect(badge).toBeTruthy();
	});
});

describe("Inspector TurnBlock", () => {
	it("renders each turn's role, idx, and VAD voice ms range formatted as seconds", async () => {
		mockReplay(
			buildReplay({
				turns: [
					{
						idx: 0,
						role: "user",
						turn_start_ms: 0,
						turn_end_ms: 2500,
						voice_start_ms: 120,
						voice_end_ms: 2380,
					},
					{
						idx: 1,
						role: "agent",
						turn_start_ms: 3000,
						turn_end_ms: 6500,
						voice_start_ms: 3050,
						voice_end_ms: 6450,
					},
				],
			}),
		);
		const { ui } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		const items = await waitFor(() => {
			const list = screen.getByText("Turns").closest("[data-slot='card']");
			if (list === null) throw new Error("Turns card not rendered yet");
			return list.querySelectorAll("ol > li");
		});
		expect(items.length).toBe(2);

		const first = items[0];
		expect(first?.textContent).toMatch(/user/);
		expect(first?.textContent).toMatch(/#0/);
		expect(first?.textContent).toMatch(/0\.12s → 2\.38s/);

		const second = items[1];
		expect(second?.textContent).toMatch(/agent/);
		expect(second?.textContent).toMatch(/#1/);
		expect(second?.textContent).toMatch(/3\.05s → 6\.45s/);
	});
});
