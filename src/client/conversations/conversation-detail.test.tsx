import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");

afterEach(() => cleanup());

const CONVERSATION_ID = "conv-x";

interface ReplaySummary {
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
	judge_status: "passed" | "failed" | "errored" | null;
	judge_score: number | null;
	run_config: unknown;
}

const REPLAY_FIXTURES: ReplaySummary[] = [
	{
		id: "11111111-1111-1111-1111-111111111111",
		conversation_id: CONVERSATION_ID,
		conversation_version: "v1",
		status: "completed",
		failure_reason: null,
		modality: "voice",
		started_at: "2026-05-15T10:00:00.000Z",
		finished_at: "2026-05-15T10:00:30.000Z",
		judge_status: "passed",
		judge_score: 5,
		run_config: null,
	},
	{
		id: "22222222-2222-2222-2222-222222222222",
		conversation_id: CONVERSATION_ID,
		conversation_version: "v1",
		status: "failed",
		failure_reason: "runtime_error",
		modality: "voice",
		started_at: "2026-05-15T10:01:00.000Z",
		finished_at: "2026-05-15T10:01:30.000Z",
		judge_status: null,
		judge_score: null,
		run_config: null,
	},
	{
		id: "33333333-3333-3333-3333-333333333333",
		conversation_id: CONVERSATION_ID,
		conversation_version: "v1",
		status: "running",
		failure_reason: null,
		modality: "voice",
		started_at: "2026-05-15T10:02:00.000Z",
		finished_at: null,
		judge_status: null,
		judge_score: null,
		run_config: null,
	},
];

function mockConversationAndReplays() {
	server.use(
		http.get(`http://localhost/v1/conversations/${CONVERSATION_ID}`, () =>
			HttpResponse.json({
				id: CONVERSATION_ID,
				version: "v1",
				title: "Title X",
				created_at: "2026-05-15T00:00:00.000Z",
				turns: [{ role: "user", text: "hello" }],
			}),
		),
		http.get(`http://localhost/v1/conversations/${CONVERSATION_ID}/replays`, () =>
			HttpResponse.json({ items: REPLAY_FIXTURES }),
		),
	);
}

describe("ConversationDetail", () => {
	it("renders the replays list with status chips for each row", async () => {
		mockConversationAndReplays();
		const { ui } = renderWithRouter({
			initialEntries: [`/conversations/${CONVERSATION_ID}`],
		});
		render(ui);

		await waitFor(() => expect(screen.getByText("completed")).toBeTruthy());
		expect(screen.getByText(/failed: runtime_error/)).toBeTruthy();
		expect(screen.getByText("running")).toBeTruthy();
	});

	it("exposes the failureReason as visible text on a failed replay", async () => {
		mockConversationAndReplays();
		const { ui } = renderWithRouter({
			initialEntries: [`/conversations/${CONVERSATION_ID}`],
		});
		render(ui);

		const failedChip = await waitFor(() => screen.getByText(/failed: runtime_error/));
		expect(failedChip.textContent).toContain("runtime_error");
	});

	it("Compare-Replays button enables for 2 selected, disables for 1 or >8", async () => {
		mockConversationAndReplays();
		const { ui } = renderWithRouter({
			initialEntries: [`/conversations/${CONVERSATION_ID}`],
		});
		render(ui);

		const button = await waitFor(() => screen.getByRole("button", { name: /^Compare/ }));
		expect(button.hasAttribute("disabled")).toBe(true);

		const checkboxes = await waitFor(() => {
			const found = screen.getAllByRole("checkbox", { name: /Select replay/ });
			if (found.length < 3) throw new Error("checkboxes not yet rendered");
			return found;
		});

		const checkbox0 = checkboxes[0];
		const checkbox1 = checkboxes[1];
		if (checkbox0 === undefined || checkbox1 === undefined) throw new Error("missing checkboxes");

		await act(async () => {
			fireEvent.click(checkbox0);
		});
		expect(button.hasAttribute("disabled")).toBe(true);

		await act(async () => {
			fireEvent.click(checkbox1);
		});
		await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
	});
});
