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
	started_at: string | null;
	ended_at: string | null;
	transcript: string | null;
	audio_path: string | null;
}

function buildReplay(
	id: string,
	turns: ReplayTurn[],
	run_config: unknown = null,
): {
	id: string;
	conversation_hash: string;
	status: "completed";
	failure_reason: null;
	modality: "voice";
	started_at: string;
	finished_at: string;
	audio_path: null;
	transcript: null;
	run_config: unknown;
	judge: { status: null; score: null; reason: null; error: null };
	turns: ReplayTurn[];
	assertions: never[];
	tool_calls: never[];
	model_usage: never[];
	spans: never[];
} {
	return {
		id,
		conversation_hash: "a".repeat(64),
		status: "completed",
		failure_reason: null,
		modality: "voice",
		started_at: "2026-05-15T10:00:00.000Z",
		finished_at: "2026-05-15T10:00:30.000Z",
		audio_path: null,
		transcript: null,
		run_config,
		judge: { status: null, score: null, reason: null, error: null },
		turns,
		assertions: [],
		tool_calls: [],
		model_usage: [],
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
				started_at: null,
				ended_at: null,
				transcript: "hi",
				audio_path: null,
			},
			{
				idx: 1,
				role: "agent",
				key: "only-a",
				started_at: null,
				ended_at: null,
				transcript: "alone",
				audio_path: null,
			},
		]);
		const replayB = buildReplay("22222222-2222-2222-2222-222222222222", [
			{
				idx: 0,
				role: "user",
				key: "greet",
				started_at: null,
				ended_at: null,
				transcript: "yo",
				audio_path: null,
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
					started_at: null,
					ended_at: null,
					transcript: "hi",
					audio_path: null,
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
					started_at: null,
					ended_at: null,
					transcript: "yo",
					audio_path: null,
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
