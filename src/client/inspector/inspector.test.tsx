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
	conversationId: string;
	conversationVersion: string;
	status: "running" | "completed" | "failed";
	failureReason: "agent_not_joined" | "runtime_error" | "audio_missing" | "sdk_aborted" | "other" | null;
	modality: "voice" | "text";
	startedAt: string;
	finishedAt: string | null;
	audioPath: string | null;
	transcript: string | null;
	runConfig: unknown;
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
		startedAt: string | null;
		endedAt: string | null;
		transcript: string | null;
		audioPath: string | null;
	}>;
	assertions: Array<{
		id: number;
		turnIdx: number;
		name: string;
		status: "passed" | "failed" | "errored";
		message: string | null;
		recordedAt: string;
	}>;
	toolCalls: never[];
	modelUsage: never[];
	spans: never[];
}

function buildReplay(overrides: Partial<ReplayDetailFixture> = {}): ReplayDetailFixture {
	return {
		id: REPLAY_ID,
		conversationId: "conv-x",
		conversationVersion: "v1",
		status: "completed",
		failureReason: null,
		modality: "voice",
		startedAt: "2026-05-15T10:00:00.000Z",
		finishedAt: "2026-05-15T10:00:30.000Z",
		audioPath: null,
		transcript: null,
		runConfig: null,
		judge: { status: null, score: null, reason: null, error: null },
		turns: [
			{
				idx: 0,
				role: "user",
				key: "greet",
				startedAt: "2026-05-15T10:00:01.000Z",
				endedAt: "2026-05-15T10:00:02.000Z",
				transcript: "hello",
				audioPath: null,
			},
			{
				idx: 1,
				role: "agent",
				key: "respond",
				startedAt: "2026-05-15T10:00:03.000Z",
				endedAt: "2026-05-15T10:00:04.000Z",
				transcript: "hi there",
				audioPath: null,
			},
		],
		assertions: [],
		toolCalls: [],
		modelUsage: [],
		spans: [],
		...overrides,
	};
}

function mockReplay(replay: ReplayDetailFixture) {
	server.use(
		http.get(`http://localhost/v1/replays/${replay.id}`, () => HttpResponse.json(replay)),
	);
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
						turnIdx: 0,
						name: "a",
						status: "passed",
						message: null,
						recordedAt: "2026-05-15T10:00:05.000Z",
					},
					{
						id: 2,
						turnIdx: 0,
						name: "b",
						status: "passed",
						message: null,
						recordedAt: "2026-05-15T10:00:05.000Z",
					},
					{
						id: 3,
						turnIdx: 1,
						name: "c",
						status: "failed",
						message: "boom",
						recordedAt: "2026-05-15T10:00:05.000Z",
					},
					{
						id: 4,
						turnIdx: 1,
						name: "d",
						status: "errored",
						message: null,
						recordedAt: "2026-05-15T10:00:05.000Z",
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
						turnIdx: 0,
						name: "user.said_hello",
						status: "passed",
						message: null,
						recordedAt: "2026-05-15T10:00:05.000Z",
					},
					{
						id: 2,
						turnIdx: 1,
						name: "agent.was_polite",
						status: "failed",
						message: "did not greet",
						recordedAt: "2026-05-15T10:00:05.000Z",
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
