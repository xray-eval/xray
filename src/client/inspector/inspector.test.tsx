import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");

afterEach(() => cleanup());

const REPLAY_ID = "44444444-4444-4444-4444-444444444444";

interface ReplayDetailFixture {
	id: string;
	conversation_id: string;
	conversation_version: string;
	status: "running" | "completed" | "failed";
	failure_reason:
		| "agent_not_joined"
		| "runtime_error"
		| "audio_missing"
		| "sdk_aborted"
		| "other"
		| null;
	modality: "voice" | "text";
	started_at: string;
	finished_at: string | null;
	audio_path: string | null;
	transcript: string | null;
	run_config: unknown;
	judge: {
		status: "passed" | "failed" | "errored" | null;
		score: number | null;
		reason: string | null;
		error: string | null;
	};
	turns: Array<{
		idx: number;
		role: "user" | "agent";
		key: string | null;
		started_at: string | null;
		ended_at: string | null;
		transcript: string | null;
		audio_path: string | null;
	}>;
	assertions: Array<{
		id: number;
		turn_idx: number;
		name: string;
		status: "passed" | "failed" | "errored";
		message: string | null;
		recorded_at: string;
	}>;
	tool_calls: never[];
	model_usage: never[];
	spans: never[];
}

function buildReplay(overrides: Partial<ReplayDetailFixture> = {}): ReplayDetailFixture {
	return {
		id: REPLAY_ID,
		conversation_id: "conv-x",
		conversation_version: "v1",
		status: "completed",
		failure_reason: null,
		modality: "voice",
		started_at: "2026-05-15T10:00:00.000Z",
		finished_at: "2026-05-15T10:00:30.000Z",
		audio_path: null,
		transcript: null,
		run_config: null,
		judge: { status: null, score: null, reason: null, error: null },
		turns: [
			{
				idx: 0,
				role: "user",
				key: "greet",
				started_at: "2026-05-15T10:00:01.000Z",
				ended_at: "2026-05-15T10:00:02.000Z",
				transcript: "hello",
				audio_path: null,
			},
			{
				idx: 1,
				role: "agent",
				key: "respond",
				started_at: "2026-05-15T10:00:03.000Z",
				ended_at: "2026-05-15T10:00:04.000Z",
				transcript: "hi there",
				audio_path: null,
			},
		],
		assertions: [],
		tool_calls: [],
		model_usage: [],
		spans: [],
		...overrides,
	};
}

function mockReplay(replay: ReplayDetailFixture) {
	server.use(http.get(`http://localhost/v1/replays/${replay.id}`, () => HttpResponse.json(replay)));
}

describe("Inspector empty states", () => {
	it("renders the new @xray.trace copy when the replay has no spans", async () => {
		mockReplay(buildReplay({ spans: [] }));
		const { ui } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		const empty = await waitFor(() => screen.getByText(/No trace spans recorded/i));
		expect(empty.textContent).toMatch(/@xray\.trace\.stage/);
		expect(empty.textContent).toMatch(/docs\/SDK\.md/);
	});
});

describe("Inspector AssertionsCard summary", () => {
	it("renders aggregate pass/fail/errored counts as the summary card", async () => {
		mockReplay(
			buildReplay({
				assertions: [
					{
						id: 1,
						turn_idx: 0,
						name: "a",
						status: "passed",
						message: null,
						recorded_at: "2026-05-15T10:00:05.000Z",
					},
					{
						id: 2,
						turn_idx: 0,
						name: "b",
						status: "passed",
						message: null,
						recorded_at: "2026-05-15T10:00:05.000Z",
					},
					{
						id: 3,
						turn_idx: 1,
						name: "c",
						status: "failed",
						message: "boom",
						recorded_at: "2026-05-15T10:00:05.000Z",
					},
					{
						id: 4,
						turn_idx: 1,
						name: "d",
						status: "errored",
						message: null,
						recorded_at: "2026-05-15T10:00:05.000Z",
					},
				],
			}),
		);
		const { ui } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		await waitFor(() => expect(screen.getByLabelText("2 passed")).toBeTruthy());
		expect(screen.getByLabelText("1 failed")).toBeTruthy();
		expect(screen.getByLabelText("1 errored")).toBeTruthy();
	});
});

describe("Inspector TurnBlock inline assertions", () => {
	it("renders the assertions whose turnIdx matches the turn, inline below it", async () => {
		mockReplay(
			buildReplay({
				assertions: [
					{
						id: 1,
						turn_idx: 0,
						name: "user.said_hello",
						status: "passed",
						message: null,
						recorded_at: "2026-05-15T10:00:05.000Z",
					},
					{
						id: 2,
						turn_idx: 1,
						name: "agent.was_polite",
						status: "failed",
						message: "did not greet",
						recorded_at: "2026-05-15T10:00:05.000Z",
					},
				],
			}),
		);
		const { ui } = renderWithRouter({ initialEntries: [`/replays/${REPLAY_ID}`] });
		render(ui);

		const turn0List = await waitFor(() =>
			screen.getByRole("list", { name: /Assertions for turn 0/i }),
		);
		expect(turn0List.textContent).toMatch(/user\.said_hello/);
		expect(turn0List.textContent).not.toMatch(/agent\.was_polite/);

		const turn1List = screen.getByRole("list", { name: /Assertions for turn 1/i });
		expect(turn1List.textContent).toMatch(/agent\.was_polite/);
		expect(turn1List.textContent).toMatch(/did not greet/);
	});
});
