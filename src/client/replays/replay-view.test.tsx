import { HttpResponse, http } from "msw";

import { makeReplayRunResponse } from "@/server/replays/replays.test-utils.ts";
import { makeConversation, makeConversationTurn } from "@/server/sessions/sessions.test-utils.ts";
import { server } from "@/test-server.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");

afterEach(() => cleanup());

const REPLAY_URL = "http://localhost/v1/replays/r-1";
const SOURCE_URL = "http://localhost/v1/sessions/sess-source";
const TARGET_URL = "http://localhost/v1/sessions/sess-target";

describe("ReplayView — terminal states", () => {
	it("renders progress when the run is still running", async () => {
		server.use(
			http.get(REPLAY_URL, () =>
				HttpResponse.json(
					makeReplayRunResponse({
						id: "r-1",
						status: "running",
						progress: { completed: 2, total: 5 },
					}),
				),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/replays/r-1"] });
		render(ui);
		await waitFor(() => expect(screen.getByText(/replaying turns/i)).toBeTruthy());
		expect(screen.getByText(/2 of 5 user turns processed/i)).toBeTruthy();
		const bar = screen.getByRole("progressbar");
		expect(bar.getAttribute("aria-valuenow")).toBe("40");
	});

	it("renders the error message when the run failed", async () => {
		server.use(
			http.get(REPLAY_URL, () =>
				HttpResponse.json(
					makeReplayRunResponse({
						id: "r-1",
						status: "failed",
						error: "Webhook returned HTTP 500",
					}),
				),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/replays/r-1"] });
		render(ui);
		await waitFor(() => expect(screen.getByText(/replay failed/i)).toBeTruthy());
		expect(screen.getByText(/Webhook returned HTTP 500/i)).toBeTruthy();
	});
});

describe("ReplayView — completed diff", () => {
	it("fetches source + target and renders aligned turn pairs", async () => {
		server.use(
			http.get(REPLAY_URL, () =>
				HttpResponse.json(
					makeReplayRunResponse({
						id: "r-1",
						sourceSessionId: "sess-source",
						targetSessionId: "sess-target",
						status: "completed",
						progress: { completed: 1, total: 1 },
					}),
				),
			),
			http.get(SOURCE_URL, () =>
				HttpResponse.json(
					makeConversation({
						id: "sess-source",
						turns: [
							makeConversationTurn({ id: "t-0", idx: 0, role: "user", text: "hi" }),
							makeConversationTurn({ id: "t-1", idx: 1, role: "agent", text: "hi back" }),
						],
					}),
				),
			),
			http.get(TARGET_URL, () =>
				HttpResponse.json(
					makeConversation({
						id: "sess-target",
						turns: [
							makeConversationTurn({ id: "t-0", idx: 0, role: "user", text: "hi" }),
							makeConversationTurn({ id: "t-1", idx: 1, role: "agent", text: "hi there" }),
						],
					}),
				),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/replays/r-1"] });
		render(ui);
		// Same tools + same shape + text-only difference → "Behavior matches":
		// text wording is shown but never flagged as divergence.
		await waitFor(() => expect(screen.getByText(/behavior matches/i)).toBeTruthy());
		expect(screen.getByText("hi back")).toBeTruthy();
		expect(screen.getByText("hi there")).toBeTruthy();
		expect(screen.getByText(/2 aligned turns/i)).toBeTruthy();
	});

	it("renders an audio element for each turn that has audioPath", async () => {
		server.use(
			http.get(REPLAY_URL, () =>
				HttpResponse.json(
					makeReplayRunResponse({
						id: "r-1",
						sourceSessionId: "sess-source",
						targetSessionId: "sess-target",
						status: "completed",
						mode: "realtime",
					}),
				),
			),
			http.get(SOURCE_URL, () =>
				HttpResponse.json(
					makeConversation({
						id: "sess-source",
						turns: [
							makeConversationTurn({
								id: "t-0",
								idx: 0,
								role: "user",
								text: "hi",
								audioPath: "sess-source/0.wav",
							}),
							makeConversationTurn({
								id: "t-1",
								idx: 1,
								role: "agent",
								text: "hi back",
								audioPath: "sess-source/1.wav",
							}),
						],
					}),
				),
			),
			http.get(TARGET_URL, () =>
				HttpResponse.json(
					makeConversation({
						id: "sess-target",
						turns: [
							makeConversationTurn({
								id: "t-0",
								idx: 0,
								role: "user",
								text: "hi",
								audioPath: "sess-target/0.wav",
							}),
							makeConversationTurn({
								id: "t-1",
								idx: 1,
								role: "agent",
								text: "hi there",
								audioPath: "sess-target/1.wav",
							}),
						],
					}),
				),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/replays/r-1"] });
		render(ui);
		await waitFor(() => expect(screen.getByText("hi back")).toBeTruthy());

		// One audio per turn per side → 4 elements. The src URLs disambiguate
		// source vs target so the player on each side fetches the right bytes.
		const players = screen.getAllByLabelText(/^Audio for/i);
		expect(players.length).toBe(4);
		const sources = players.map((p) => p.getAttribute("src") ?? "");
		expect(sources.some((s) => s.includes("/sessions/sess-source/turns/0/audio"))).toBe(true);
		expect(sources.some((s) => s.includes("/sessions/sess-source/turns/1/audio"))).toBe(true);
		expect(sources.some((s) => s.includes("/sessions/sess-target/turns/0/audio"))).toBe(true);
		expect(sources.some((s) => s.includes("/sessions/sess-target/turns/1/audio"))).toBe(true);
	});

	it("shows 'no turn at this position' when one side is missing", async () => {
		server.use(
			http.get(REPLAY_URL, () =>
				HttpResponse.json(
					makeReplayRunResponse({
						id: "r-1",
						sourceSessionId: "sess-source",
						targetSessionId: "sess-target",
						status: "completed",
					}),
				),
			),
			http.get(SOURCE_URL, () =>
				HttpResponse.json(
					makeConversation({
						id: "sess-source",
						turns: [
							makeConversationTurn({ id: "t-0", idx: 0, role: "user", text: "hello" }),
							makeConversationTurn({ id: "t-1", idx: 1, role: "agent", text: "hi" }),
							makeConversationTurn({ id: "t-2", idx: 2, role: "user", text: "follow up" }),
						],
					}),
				),
			),
			http.get(TARGET_URL, () =>
				HttpResponse.json(
					makeConversation({
						id: "sess-target",
						turns: [makeConversationTurn({ id: "t-0", idx: 0, role: "user", text: "hello" })],
					}),
				),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/replays/r-1"] });
		render(ui);
		await waitFor(() =>
			expect(screen.getAllByText(/no turn at this position/i).length).toBeGreaterThan(0),
		);
	});
});

describe("ReplayView — back navigation", () => {
	it("navigates to / when the back button is clicked", async () => {
		server.use(
			http.get(REPLAY_URL, () =>
				HttpResponse.json(makeReplayRunResponse({ id: "r-1", status: "completed" })),
			),
			http.get(SOURCE_URL, () => HttpResponse.json(makeConversation({ id: "sess-source" }))),
			http.get(TARGET_URL, () => HttpResponse.json(makeConversation({ id: "sess-target" }))),
			http.get("http://localhost/v1/sessions", () =>
				HttpResponse.json({ sessions: [], nextCursor: null }),
			),
		);
		const { router, ui } = renderWithRouter({ initialEntries: ["/replays/r-1"] });
		render(ui);
		const back = await screen.findByRole("link", { name: /all sessions/i });
		fireEvent.click(back);
		await waitFor(() => expect(router.state.location.pathname).toBe("/"));
	});
});
