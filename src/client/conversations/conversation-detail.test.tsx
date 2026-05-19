import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import(
	"@testing-library/react"
);
const { renderWithRouter } = await import("../test-utils.tsx");

afterEach(() => cleanup());

const CONVERSATION_ID = "conv-x";

interface ReplaySummary {
	id: string;
	conversationId: string;
	conversationVersion: string;
	status: "running" | "completed" | "failed";
	failureReason:
		| "agent_not_joined"
		| "runtime_error"
		| "audio_missing"
		| "sdk_aborted"
		| "other"
		| null;
	modality: "voice" | "text";
	startedAt: string;
	finishedAt: string | null;
	judgeStatus: "passed" | "failed" | "errored" | null;
	judgeScore: number | null;
	runConfig: unknown;
}

const REPLAY_FIXTURES: ReplaySummary[] = [
	{
		id: "11111111-1111-1111-1111-111111111111",
		conversationId: CONVERSATION_ID,
		conversationVersion: "v1",
		status: "completed",
		failureReason: null,
		modality: "voice",
		startedAt: "2026-05-15T10:00:00.000Z",
		finishedAt: "2026-05-15T10:00:30.000Z",
		judgeStatus: "passed",
		judgeScore: 5,
		runConfig: null,
	},
	{
		id: "22222222-2222-2222-2222-222222222222",
		conversationId: CONVERSATION_ID,
		conversationVersion: "v1",
		status: "failed",
		failureReason: "runtime_error",
		modality: "voice",
		startedAt: "2026-05-15T10:01:00.000Z",
		finishedAt: "2026-05-15T10:01:30.000Z",
		judgeStatus: null,
		judgeScore: null,
		runConfig: null,
	},
	{
		id: "33333333-3333-3333-3333-333333333333",
		conversationId: CONVERSATION_ID,
		conversationVersion: "v1",
		status: "running",
		failureReason: null,
		modality: "voice",
		startedAt: "2026-05-15T10:02:00.000Z",
		finishedAt: null,
		judgeStatus: null,
		judgeScore: null,
		runConfig: null,
	},
];

function mockConversationAndReplays() {
	server.use(
		http.get(`http://localhost/v1/conversations/${CONVERSATION_ID}`, () =>
			HttpResponse.json({
				id: CONVERSATION_ID,
				version: "v1",
				title: "Title X",
				createdAt: "2026-05-15T00:00:00.000Z",
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
