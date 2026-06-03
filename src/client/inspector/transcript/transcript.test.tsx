import type { ReplayDetailResponse } from "../../api/api.types.ts";
import { registerHappyDom } from "../../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { PlayerProvider } = await import("../../audio/player-provider.tsx");
const { TranscriptCard } = await import("./transcript.tsx");

afterEach(() => cleanup());

function buildReplay(overrides: Partial<ReplayDetailResponse> = {}): ReplayDetailResponse {
	return {
		id: "44444444-4444-4444-4444-444444444444",
		conversation_hash: "a".repeat(64),
		lifecycle_state: "completed",
		analysis_step: null,
		failure_reason: null,
		started_at: "2026-05-15T10:00:00.000Z",
		finished_at: "2026-05-15T10:00:30.000Z",
		audio_path: "/data/audio/replay.wav",
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
		transcripts: [
			{
				turn_idx: 0,
				text: "I want to book a flight",
				language: "en",
				words: null,
				duration_ms: 2300,
				provider: "openai_whisper",
				model: "whisper-1",
			},
			{
				turn_idx: 1,
				text: "Sure, where to?",
				language: "en",
				words: [
					{ text: "Sure,", start_ms: 3100, end_ms: 3500 },
					{ text: "where", start_ms: 3510, end_ms: 3800 },
					{ text: "to?", start_ms: 3810, end_ms: 4000 },
				],
				duration_ms: 3300,
				provider: "openai_whisper",
				model: "whisper-1",
			},
		],
		turn_metrics: [],
		tool_calls: [],
		model_usage: [],
		spans: [],
		...overrides,
	};
}

function renderCard(replay: ReplayDetailResponse) {
	render(
		<PlayerProvider>
			<TranscriptCard replay={replay} />
		</PlayerProvider>,
	);
}

describe("TranscriptCard", () => {
	it("renders each turn's text with a role tag", () => {
		renderCard(buildReplay());
		expect(screen.getByText(/I want to book a flight/)).toBeTruthy();
		expect(screen.getByText(/Sure, where to\?/)).toBeTruthy();
		expect(screen.getByText("User")).toBeTruthy();
		expect(screen.getByText("Agent")).toBeTruthy();
		expect(screen.getByText(/openai_whisper/)).toBeTruthy();
	});

	it("renders nothing when there are no transcripts", () => {
		const { container } = render(
			<PlayerProvider>
				<TranscriptCard replay={buildReplay({ transcripts: [] })} />
			</PlayerProvider>,
		);
		expect(container.textContent).toBe("");
	});

	it("exposes each turn as a clickable seek target", () => {
		renderCard(buildReplay());
		const [first, second] = screen.getAllByRole("button");
		expect(second).toBeTruthy();
		if (first === undefined) throw new Error("expected a transcript turn button");
		// No real wavesurfer is mounted, so seek is a safe no-op — clicking must
		// not throw.
		fireEvent.click(first);
	});
});
