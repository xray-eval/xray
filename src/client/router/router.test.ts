import { HttpResponse, http } from "msw";

import { makeReplayRunResponse } from "@/server/replays/replays.test-utils.ts";
import {
	makeConversation,
	makeListSessionsResponse,
} from "@/server/sessions/sessions.test-utils.ts";
import { server } from "@/test-server.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");

afterEach(() => cleanup());

const SESSIONS_URL = "http://localhost/v1/sessions";

describe("router — route resolution", () => {
	it("mounts ConversationsList at /", async () => {
		server.use(http.get(SESSIONS_URL, () => HttpResponse.json(makeListSessionsResponse())));
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		expect(await screen.findByText(/no sessions yet/i)).toBeTruthy();
	});

	it("mounts Inspector at /sessions/$sessionId and wires the param through", async () => {
		server.use(
			http.get("http://localhost/v1/sessions/sess-42", () =>
				HttpResponse.json(makeConversation({ id: "sess-42", agentId: "agent-42" })),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-42"] });
		render(ui);
		expect(await screen.findByText("agent-42")).toBeTruthy();
		expect(screen.getByText("sess-42")).toBeTruthy();
	});

	it("mounts ReplayView at /replays/$replayId and wires the param through", async () => {
		server.use(
			http.get("http://localhost/v1/replays/r-7", () =>
				HttpResponse.json(makeReplayRunResponse({ id: "r-7", status: "running" })),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/replays/r-7"] });
		render(ui);
		expect(await screen.findByText(/replaying turns/i)).toBeTruthy();
	});
});

describe("router — not found", () => {
	it("renders the not-found view for an unknown path", async () => {
		const { ui } = renderWithRouter({ initialEntries: ["/nope/this/does/not/exist"] });
		render(ui);
		expect(await screen.findByText(/page not found/i)).toBeTruthy();
	});

	it("offers a link back to /", async () => {
		const { router, ui } = renderWithRouter({ initialEntries: ["/garbage"] });
		render(ui);
		const back = await screen.findByRole("link", { name: /back to sessions/i });
		server.use(http.get(SESSIONS_URL, () => HttpResponse.json(makeListSessionsResponse())));
		fireEvent.click(back);
		await waitFor(() => expect(router.state.location.pathname).toBe("/"));
	});
});
