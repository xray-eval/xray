import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");

afterEach(() => cleanup());

interface ReplayTurn {
	idx: number;
	role: "user" | "agent";
	key: string | null;
	startedAt: string | null;
	endedAt: string | null;
	transcript: string | null;
	audioPath: string | null;
}

function buildReplay(
	id: string,
	turns: ReplayTurn[],
	runConfig: unknown = null,
): {
	id: string;
	conversationId: string;
	conversationVersion: string;
	status: "completed";
	failureReason: null;
	modality: "voice";
	startedAt: string;
	finishedAt: string;
	audioPath: null;
	transcript: null;
	runConfig: unknown;
	judge: { status: null; score: null; reason: null; error: null };
	turns: ReplayTurn[];
	assertions: never[];
	toolCalls: never[];
	modelUsage: never[];
	spans: never[];
} {
	return {
		id,
		conversationId: "conv-x",
		conversationVersion: "v1",
		status: "completed",
		failureReason: null,
		modality: "voice",
		startedAt: "2026-05-15T10:00:00.000Z",
		finishedAt: "2026-05-15T10:00:30.000Z",
		audioPath: null,
		transcript: null,
		runConfig,
		judge: { status: null, score: null, reason: null, error: null },
		turns,
		assertions: [],
		toolCalls: [],
		modelUsage: [],
		spans: [],
	};
}

describe("CompareReplays route", () => {
	it("renders 'no matching turn' placeholder when one replay is missing a key", async () => {
		const replayA = buildReplay("11111111-1111-1111-1111-111111111111", [
			{
				idx: 0,
				role: "user",
				key: "greet",
				startedAt: null,
				endedAt: null,
				transcript: "hi",
				audioPath: null,
			},
			{
				idx: 1,
				role: "agent",
				key: "only-a",
				startedAt: null,
				endedAt: null,
				transcript: "alone",
				audioPath: null,
			},
		]);
		const replayB = buildReplay("22222222-2222-2222-2222-222222222222", [
			{
				idx: 0,
				role: "user",
				key: "greet",
				startedAt: null,
				endedAt: null,
				transcript: "yo",
				audioPath: null,
			},
		]);
		server.use(
			http.post("http://localhost/v1/replays/compare", () =>
				HttpResponse.json({ replays: [replayA, replayB] }),
			),
		);

		const { ui } = renderWithRouter({
			initialEntries: [
				"/compare/replays?ids=11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222",
			],
		});
		render(ui);

		await waitFor(() => expect(screen.getAllByText(/no matching turn/i).length).toBeGreaterThan(0));
	});

	it("rejects fewer than 2 replay ids in the query", async () => {
		const { ui } = renderWithRouter({
			initialEntries: ["/compare/replays?ids=11111111-1111-1111-1111-111111111111"],
		});
		render(ui);

		await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/between 2 and 8/));
	});

	it("rejects more than 8 replay ids in the query", async () => {
		const ids = Array.from(
			{ length: 9 },
			(_, i) => `${i.toString(16)}1111111-1111-1111-1111-111111111111`,
		).join(",");
		const { ui } = renderWithRouter({
			initialEntries: [`/compare/replays?ids=${ids}`],
		});
		render(ui);

		await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/between 2 and 8/));
	});

	it("highlights only the run_config keys that differ between replays", async () => {
		const replayA = buildReplay(
			"11111111-1111-1111-1111-111111111111",
			[
				{
					idx: 0,
					role: "user",
					key: "greet",
					startedAt: null,
					endedAt: null,
					transcript: "hi",
					audioPath: null,
				},
			],
			{ model: "gpt-4", temperature: 0.2 },
		);
		const replayB = buildReplay(
			"22222222-2222-2222-2222-222222222222",
			[
				{
					idx: 0,
					role: "user",
					key: "greet",
					startedAt: null,
					endedAt: null,
					transcript: "yo",
					audioPath: null,
				},
			],
			{ model: "gpt-4o", temperature: 0.2 },
		);
		server.use(
			http.post("http://localhost/v1/replays/compare", () =>
				HttpResponse.json({ replays: [replayA, replayB] }),
			),
		);

		const { ui } = renderWithRouter({
			initialEntries: [
				"/compare/replays?ids=11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222",
			],
		});
		render(ui);

		const modelRow = await waitFor(() => screen.getByLabelText("run_config.model"));
		const tempRow = screen.getByLabelText("run_config.temperature");

		const modelCells = modelRow.querySelectorAll("td");
		expect(modelCells.length).toBe(2);
		expect(modelCells[0]?.className).not.toMatch(/bg-yellow/);
		expect(modelCells[1]?.className).toMatch(/bg-yellow/);

		const tempCells = tempRow.querySelectorAll("td");
		for (const cell of tempCells) {
			expect(cell.className).not.toMatch(/bg-yellow/);
		}
	});
});
