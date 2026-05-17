import { HttpResponse, http } from "msw";

import { makeReplayRunResponse } from "@/server/replays/replays.test-utils.ts";
import { server } from "@/test-server.ts";

import { registerHappyDom } from "../../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../../test-utils.tsx");

afterEach(() => cleanup());

const LIST_URL = "http://localhost/v1/sessions/sess-1/replays";
const CONVO_URL = "http://localhost/v1/sessions/sess-1";

async function openReplaysTab() {
	const tab = await screen.findByRole("tab", { name: /replays/i });
	// Radix Tabs activates on `onMouseDown`, not `onClick` — `fireEvent.click`
	// fires on the DOM node without flipping the panel.
	fireEvent.mouseDown(tab);
}

function stubConversation() {
	server.use(
		http.get(CONVO_URL, () =>
			HttpResponse.json({
				id: "sess-1",
				agentId: "agent-1",
				startedAt: "2026-05-16T12:00:00.000Z",
				endedAt: null,
				durationMs: null,
				source: "ingest",
				turns: [],
			}),
		),
	);
}

describe("ReplaysTab — pending state", () => {
	it("marks the replays section aria-busy while loading", async () => {
		stubConversation();
		const never = new Promise<Response>(() => {
			// noop: never resolves so the query stays pending.
		});
		server.use(http.get(LIST_URL, () => never));
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		await openReplaysTab();
		// Target the `<section>` by role to avoid colliding with the trigger
		// `<button role="tab" aria-label="Replays">`.
		const region = await screen.findByRole("region", { name: /replays/i });
		expect(region.getAttribute("aria-busy")).toBe("true");
	});
});

describe("ReplaysTab — empty state", () => {
	it("renders the empty hint with the Replay-button copy", async () => {
		stubConversation();
		server.use(http.get(LIST_URL, () => HttpResponse.json({ items: [] })));
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		await openReplaysTab();
		await waitFor(() => expect(screen.getByText(/no replays yet/i)).toBeTruthy());
		expect(screen.getByText(/use the replay button to create one/i)).toBeTruthy();
	});
});

describe("ReplaysTab — list", () => {
	it("renders each replay with its status, mode, and started-at", async () => {
		stubConversation();
		server.use(
			http.get(LIST_URL, () =>
				HttpResponse.json({
					items: [
						makeReplayRunResponse({
							id: "11111111-1111-1111-1111-111111111111",
							status: "completed",
							mode: "text",
							startedAt: "2026-05-16T12:00:00.000Z",
						}),
						makeReplayRunResponse({
							id: "22222222-2222-2222-2222-222222222222",
							status: "running",
							mode: "realtime",
							startedAt: "2026-05-16T13:00:00.000Z",
						}),
					],
				}),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		await openReplaysTab();

		await waitFor(() => expect(screen.getByText(/completed/i)).toBeTruthy());
		expect(screen.getByText(/running/i)).toBeTruthy();
		expect(screen.getByText("text")).toBeTruthy();
		expect(screen.getByText("realtime")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: /open replay 11111111-1111-1111-1111-111111111111/i }),
		).toBeTruthy();
	});

	it("navigates to /replays/$replayId when a row is clicked", async () => {
		stubConversation();
		server.use(
			http.get(LIST_URL, () =>
				HttpResponse.json({
					items: [
						makeReplayRunResponse({
							id: "11111111-1111-1111-1111-111111111111",
							status: "completed",
						}),
					],
				}),
			),
		);
		const { router, ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		await openReplaysTab();
		const row = await screen.findByRole("link", {
			name: /open replay 11111111-1111-1111-1111-111111111111/i,
		});
		fireEvent.click(row);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/replays/11111111-1111-1111-1111-111111111111"),
		);
	});
});

describe("ReplaysTab — error state", () => {
	it("renders an alert with a retry button on 500", async () => {
		stubConversation();
		server.use(
			http.get(LIST_URL, () => HttpResponse.json({ error: "internal_error" }, { status: 500 })),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		await openReplaysTab();
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
	});
});
