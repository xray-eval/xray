import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import type { ReplayDetailResponse, ReplayTurnResponse } from "../api/api.types.ts";
import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");

afterEach(() => cleanup());

function buildReplay(
	id: string,
	turns: ReplayTurnResponse[],
	run_config: unknown = null,
): ReplayDetailResponse {
	return {
		id,
		conversation_hash: "a".repeat(64),
		lifecycle_state: "completed",
		analysis_step: null,
		failure_reason: null,
		started_at: "2026-05-15T10:00:00.000Z",
		finished_at: "2026-05-15T10:00:30.000Z",
		audio_path: null,
		job_id: null,
		run_config,
		turns,
		speech_segments: [],
		tool_calls: [],
		model_usage: [],
		spans: [],
	};
}

const TURN_FIXTURE: ReplayTurnResponse = {
	idx: 0,
	role: "user",
	turn_start_ms: 0,
	turn_end_ms: 2500,
	voice_start_ms: 100,
	voice_end_ms: 2400,
};

describe("CompareReplays route", () => {
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
		const replayA = buildReplay("11111111-1111-1111-1111-111111111111", [TURN_FIXTURE], {
			model: "gpt-4",
			temperature: 0.2,
		});
		const replayB = buildReplay("22222222-2222-2222-2222-222222222222", [TURN_FIXTURE], {
			model: "gpt-4o",
			temperature: 0.2,
		});
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

	it("highlights only the turn whose VAD timing diverges between replays", async () => {
		const sharedTurn0: ReplayTurnResponse = {
			idx: 0,
			role: "user",
			turn_start_ms: 0,
			turn_end_ms: 2500,
			voice_start_ms: 100,
			voice_end_ms: 2400,
		};
		const replayA = buildReplay("11111111-1111-1111-1111-111111111111", [
			sharedTurn0,
			{
				idx: 1,
				role: "agent",
				turn_start_ms: 2600,
				turn_end_ms: 5000,
				voice_start_ms: 2700,
				voice_end_ms: 4900,
			},
		]);
		const replayB = buildReplay("22222222-2222-2222-2222-222222222222", [
			sharedTurn0,
			{
				idx: 1,
				role: "agent",
				turn_start_ms: 2600,
				turn_end_ms: 8000,
				voice_start_ms: 2700,
				voice_end_ms: 7800,
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

		const turn0Row = await waitFor(() => screen.getByLabelText("turn.0"));
		const turn1Row = screen.getByLabelText("turn.1");

		for (const cell of turn0Row.querySelectorAll("td")) {
			expect(cell.className).not.toMatch(/bg-yellow/);
		}

		const turn1Cells = turn1Row.querySelectorAll("td");
		expect(turn1Cells.length).toBe(2);
		expect(turn1Cells[0]?.className).not.toMatch(/bg-yellow/);
		expect(turn1Cells[1]?.className).toMatch(/bg-yellow/);
	});

	it("flags a missing turn idx as differing from the baseline replay", async () => {
		const replayA = buildReplay("11111111-1111-1111-1111-111111111111", [
			TURN_FIXTURE,
			{
				idx: 1,
				role: "agent",
				turn_start_ms: 2600,
				turn_end_ms: 5000,
				voice_start_ms: 2700,
				voice_end_ms: 4900,
			},
		]);
		const replayB = buildReplay("22222222-2222-2222-2222-222222222222", [TURN_FIXTURE]);
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

		const turn1Row = await waitFor(() => screen.getByLabelText("turn.1"));
		const cells = turn1Row.querySelectorAll("td");
		expect(cells.length).toBe(2);
		expect(cells[0]?.className).not.toMatch(/bg-yellow/);
		expect(cells[1]?.className).toMatch(/bg-yellow/);
		expect(cells[1]?.textContent ?? "").toMatch(/absent/i);
	});
});
