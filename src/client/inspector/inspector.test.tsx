import { HttpResponse, http } from "msw";

import {
	makeConversation,
	makeConversationToolCall,
	makeConversationTurn,
} from "@/server/sessions/sessions.test-utils.ts";
import { server } from "@/test-server.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");

afterEach(() => cleanup());

const CONVO_URL = "http://localhost/v1/sessions/sess-1";

describe("Inspector — pending state", () => {
	it("marks the section as aria-busy while loading", async () => {
		// MSW handler that never resolves so we observe the pending state. We
		// can't await the eventual render here — we wait for the section to
		// mount, then assert synchronously.
		const never = new Promise<Response>(() => {
			// noop: intentionally never resolves to keep the query in `pending`.
		});
		server.use(http.get(CONVO_URL, () => never));
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		const section = await screen.findByLabelText(/transcript/i);
		expect(section.getAttribute("aria-busy")).toBe("true");
	});
});

describe("Inspector — pipeline-style fixture", () => {
	it("renders turns with response-latency chips and no barge-in indicator", async () => {
		const conv = makeConversation({
			id: "sess-1",
			agentId: "agent-pipe",
			turns: [
				makeConversationTurn({ id: "t-0", idx: 0, role: "user", text: "hi" }),
				makeConversationTurn({
					id: "t-1",
					idx: 1,
					role: "agent",
					text: "hi back",
					responseLatencyMs: 420,
				}),
			],
		});
		server.use(http.get(CONVO_URL, () => HttpResponse.json(conv)));
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);

		await waitFor(() => expect(screen.getByText("agent-pipe")).toBeTruthy());
		expect(screen.getByText("hi")).toBeTruthy();
		expect(screen.getByText("hi back")).toBeTruthy();
		expect(screen.getByText("420ms")).toBeTruthy();
		expect(screen.queryByText(/interrupted/i)).toBeNull();
	});
});

describe("Inspector — voice-to-voice fixture", () => {
	it("renders the barge-in chip with the interrupted-at value", async () => {
		const conv = makeConversation({
			id: "sess-1",
			turns: [
				makeConversationTurn({
					id: "t-0",
					idx: 0,
					role: "agent",
					text: "long answer that got cut off",
					interrupted: true,
					interruptedAtMs: 800,
				}),
			],
		});
		server.use(http.get(CONVO_URL, () => HttpResponse.json(conv)));
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);

		await waitFor(() => expect(screen.getByText(/interrupted at 800ms/i)).toBeTruthy());
	});

	it("renders the barge-in chip without an interrupted-at value when null", async () => {
		const conv = makeConversation({
			id: "sess-1",
			turns: [
				makeConversationTurn({
					id: "t-0",
					idx: 0,
					role: "agent",
					interrupted: true,
					interruptedAtMs: null,
				}),
			],
		});
		server.use(http.get(CONVO_URL, () => HttpResponse.json(conv)));
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);

		await waitFor(() => {
			const badge = screen.getByLabelText(/^interrupted$/i);
			expect(badge).toBeTruthy();
		});
	});
});

describe("Inspector — tool-heavy fixture", () => {
	it("renders tool calls inside the turn with args, result, and latency", async () => {
		const conv = makeConversation({
			id: "sess-1",
			turns: [
				makeConversationTurn({
					id: "t-0",
					idx: 0,
					role: "agent",
					text: "looking that up",
					toolCalls: [
						makeConversationToolCall({
							idx: 0,
							name: "weather_lookup",
							args: { city: "Paris" },
							result: { temp: 21 },
							latencyMs: 123,
						}),
					],
				}),
			],
		});
		server.use(http.get(CONVO_URL, () => HttpResponse.json(conv)));
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);

		await waitFor(() => expect(screen.getByText("weather_lookup")).toBeTruthy());
		expect(screen.getByText("123ms")).toBeTruthy();
		// The args / result blocks render via JSON.stringify — assert on a
		// substring rather than exact whitespace.
		expect(screen.getByText(/"city": "Paris"/)).toBeTruthy();
		expect(screen.getByText(/"temp": 21/)).toBeTruthy();
	});
});

describe("Inspector — empty transcript", () => {
	it("renders the empty-turns hint when the session has metadata but no turns", async () => {
		server.use(
			http.get(CONVO_URL, () => HttpResponse.json(makeConversation({ id: "sess-1", turns: [] }))),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		await waitFor(() => expect(screen.getByText(/no turns yet/i)).toBeTruthy());
	});
});

describe("Inspector — error paths", () => {
	it("renders a 'session not found' alert on 404 without a retry button", async () => {
		server.use(
			http.get(CONVO_URL, () =>
				HttpResponse.json({ error: "session_not_found", sessionId: "sess-1" }, { status: 404 }),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		expect(await screen.findByText(/session not found/i)).toBeTruthy();
		// 404 is terminal — no point retrying the same id.
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
	});

	it("renders an alert with a retry button on 500", async () => {
		server.use(
			http.get(CONVO_URL, () => HttpResponse.json({ error: "store_failure" }, { status: 500 })),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
	});

	it("renders an alert when the body has the wrong shape", async () => {
		server.use(http.get(CONVO_URL, () => HttpResponse.json({ nope: 1 })));
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		expect(await screen.findByRole("alert")).toBeTruthy();
	});
});

describe("Inspector — back navigation", () => {
	it("navigates to / when the back button is clicked", async () => {
		server.use(
			http.get(CONVO_URL, () => HttpResponse.json(makeConversation({ id: "sess-1" }))),
			http.get("http://localhost/v1/sessions", () =>
				HttpResponse.json({ sessions: [], nextCursor: null }),
			),
		);
		const { router, ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		const back = await screen.findByRole("link", { name: /all sessions/i });
		fireEvent.click(back);
		await waitFor(() => expect(router.state.location.pathname).toBe("/"));
	});
});
