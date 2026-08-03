import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import type { ConversationResponse, ReplayDetailResponse, ReplayResult } from "../api/api.types.ts";
import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { act, cleanup, render, screen, waitFor } = await import("@testing-library/react");
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
		recording_started_at: null,
		audio_path: null,
		job_id: null,
		run_config: null,
		run_config_hash: null,
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
		transcripts: [],
		turn_metrics: [],
		tool_calls: [],
		model_usage: [],
		spans: [],
		...overrides,
	};
}

function buildConversation(hash: string): ConversationResponse {
	return {
		hash,
		name: "Test conversation",
		created_at: "2026-05-15T10:00:00.000Z",
		last_run_at: null,
		turns: [],
		judges: [],
		live: false,
	};
}

function buildResult(replay: ReplayDetailResponse): ReplayResult {
	return {
		replay_id: replay.id,
		conversation_hash: replay.conversation_hash,
		passed: true,
		assertions: [],
		judges: [],
		metrics: { turns: [] },
	};
}

// The Inspector fetches the replay, its conversation (for the breadcrumb
// label), and — once completed — its evaluation result, so all three
// endpoints must be mocked or MSW's onUnhandledRequest: "error" fires.
function mockReplay(replay: ReplayDetailResponse) {
	server.use(
		http.get(`http://localhost/v1/replays/${replay.id}`, () => HttpResponse.json(replay)),
		http.get(`http://localhost/v1/replays/${replay.id}/result`, () =>
			HttpResponse.json(buildResult(replay)),
		),
		http.get(`http://localhost/v1/conversations/${replay.conversation_hash}`, () =>
			HttpResponse.json(buildConversation(replay.conversation_hash)),
		),
	);
}

describe("Inspector empty states", () => {
	it("renders the @xray.trace copy when the replay has no spans or turns", async () => {
		mockReplay(buildReplay({ spans: [], turns: [] }));
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
	// A replay has no name of its own — the conversation it runs is the only
	// human-readable identity, so it headlines the page instead of the id.
	it("headlines the conversation name, keeping the id in the meta line", async () => {
		mockReplay(buildReplay());
		const { ui } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		await waitFor(() => screen.getByRole("heading", { level: 2, name: "Test conversation" }));
		// The eyebrow is the only other "Replay" on the page, and it's a <p> — so
		// finding it here proves the label rendered alongside the name, not instead.
		expect(screen.getByText("Replay").tagName).toBe("P");
		expect(screen.getByText(REPLAY_ID)).toBeTruthy();
	});

	it("falls back to a generic title when the conversation cannot be loaded", async () => {
		const replay = buildReplay();
		server.use(
			http.get(`http://localhost/v1/replays/${replay.id}`, () => HttpResponse.json(replay)),
			http.get(`http://localhost/v1/replays/${replay.id}/result`, () =>
				HttpResponse.json(buildResult(replay)),
			),
			http.get(`http://localhost/v1/conversations/${replay.conversation_hash}`, () =>
				HttpResponse.json({ error: "not_found" }, { status: 404 }),
			),
		);
		const { ui, queryClient } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		// Wait on the query itself, not on rendered markup: the fallback title is
		// byte-identical to the not-yet-loaded title, and the replay id paints
		// before either request settles — so any DOM anchor here passes against a
		// broken fallback too.
		await waitFor(() =>
			expect(
				queryClient.getQueryState(["conversations", { hash: replay.conversation_hash }])?.status,
			).toBe("error"),
		);
		const generic = screen.getAllByText("Replay");
		expect(generic).toHaveLength(1);
		expect(generic[0]?.tagName).toBe("H2");
	});

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
		// Together these confirm the stereo player actually mounted, not just the header chip text.
		expect(screen.getByText(/^user$/)).toBeTruthy();
		expect(screen.getByText(/^agent$/)).toBeTruthy();
		expect(screen.getByLabelText(/^Play$/i)).toBeTruthy();
		expect(screen.getByLabelText(/^Replay waveform$/i)).toBeTruthy();
	});

	it("notes that VAD has not yet published turns when audio is uploaded but turns are empty", async () => {
		mockReplay(buildReplay({ audio_path: "/data/audio/replay.wav", turns: [] }));
		const { ui } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		await waitFor(() => screen.getByText(/Stereo · 0 turns/i));
		const note = screen.getByText(/Audio uploaded\./i);
		expect(note.textContent).toMatch(/VAD analysis/);
	});
});

const SPAN = {
	id: 1,
	trace_id: "trace",
	span_id: "s-1",
	parent_span_id: null,
	name: "stt.transcribe",
	vocabulary: "xray" as const,
	started_at: "2026-05-25T10:00:00.200Z",
	ended_at: "2026-05-25T10:00:01.400Z",
	attributes_json: "{}",
	audio_offset_ms: 200,
};

function spanTreeCard(): Element {
	const card = screen.getByText("Span tree").closest('[data-slot="card"]');
	if (card === null) throw new Error("span tree card not found");
	return card;
}

describe("Inspector TraceCard", () => {
	it("renders span nodes attributed to their turn", async () => {
		mockReplay(buildReplay({ started_at: "2026-05-25T10:00:00.000Z", spans: [SPAN] }));
		const { ui } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		await waitFor(() => screen.getByText(/stt\.transcribe/));
		expect(screen.getByLabelText(/Inspect xray span stt\.transcribe$/i)).toBeTruthy();
	});

	// The span inspector is a drawer *inside* the span-tree card, not a separate
	// column — a span click must reveal it under the tree it came from.
	it("opens the span inspector inside the span-tree card", async () => {
		mockReplay(buildReplay({ started_at: "2026-05-25T10:00:00.000Z", spans: [SPAN] }));
		const { ui } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		const row = await waitFor(() => screen.getByLabelText(/Inspect xray span stt\.transcribe$/i));
		expect(spanTreeCard().textContent).toMatch(/select a span/i);

		act(() => row.click());

		const detail = screen.getByLabelText(/^span detail: stt\.transcribe$/i);
		expect(spanTreeCard().contains(detail)).toBe(true);
	});
});
