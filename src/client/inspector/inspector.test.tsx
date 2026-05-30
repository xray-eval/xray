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

		await waitFor(() => screen.getByText(/No spans recorded/i));
		const region = screen.getByText(/No spans recorded/i).closest("div");
		expect(region?.textContent).toMatch(/@xray\.trace\.stage/);
		expect(region?.textContent).toMatch(/docs\/SDK\.md/);
	});

	it("explains that VAD will populate the Turns card before audio is uploaded", async () => {
		mockReplay(buildReplay({ turns: [] }));
		const { ui } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		const empty = await waitFor(() => screen.getByText(/Awaiting audio upload/i));
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

describe("Inspector TurnsCard", () => {
	it("renders the stereo player with the turn count when audio has been uploaded", async () => {
		mockReplay(
			buildReplay({
				audio_path: "/data/audio/replay.wav",
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

		await waitFor(() => screen.getByText(/Stereo · 2 turns/i));
		// Channel legend renders the two side labels and the play button is
		// part of the bottom bar; together they confirm the stereo player
		// mounted (not just the header chip text).
		expect(screen.getByText(/^user$/)).toBeTruthy();
		expect(screen.getByText(/^agent$/)).toBeTruthy();
		expect(screen.getByLabelText(/^Play$/i)).toBeTruthy();
		expect(screen.getByLabelText(/^Replay waveform$/i)).toBeTruthy();
	});

	it("notes that VAD has not yet published turns when audio is uploaded but turns are empty", async () => {
		mockReplay(buildReplay({ audio_path: "/data/audio/replay.wav", turns: [] }));
		const { ui } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		// The player still mounts (chip says "0 turns") and the empty-state
		// hint appears below it.
		await waitFor(() => screen.getByText(/Stereo · 0 turns/i));
		const note = screen.getByText(/Audio uploaded\./i);
		expect(note.textContent).toMatch(/VAD analysis/);
	});
});

describe("Inspector TraceCard", () => {
	it("renders span nodes attributed to their turn", async () => {
		mockReplay(
			buildReplay({
				started_at: "2026-05-25T10:00:00.000Z",
				spans: [
					{
						id: 1,
						trace_id: "trace",
						span_id: "s-1",
						parent_span_id: null,
						name: "stt.transcribe",
						vocabulary: "xray",
						started_at: "2026-05-25T10:00:00.200Z",
						ended_at: "2026-05-25T10:00:01.400Z",
						attributes_json: "{}",
					},
				],
			}),
		);
		const { ui } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		await waitFor(() => screen.getByText(/stt\.transcribe/));
		expect(screen.getByLabelText(/Inspect xray span stt\.transcribe$/i)).toBeTruthy();
	});
});
