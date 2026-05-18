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

describe("BackToSessionsLink", () => {
	it("renders as a single <a> with role link (no nested button)", async () => {
		server.use(
			http.get("http://localhost/v1/sessions/sess-1", () =>
				HttpResponse.json({ error: "not_found" }, { status: 404 }),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		const link = await screen.findByRole("link", { name: /all sessions/i });
		// Invariant: the link is the actual <a> — there is no <button> inside it.
		// `asChild` on shadcn Button forwards classes to the <Link>'s <a> so
		// the visual stays the same.
		expect(link.tagName).toBe("A");
		expect(link.querySelector("button")).toBeNull();
	});

	it("uses the outline variant (matches the Replay button's weight)", async () => {
		server.use(
			http.get("http://localhost/v1/sessions/sess-1", () =>
				HttpResponse.json({ error: "not_found" }, { status: 404 }),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		const link = await screen.findByRole("link", { name: /all sessions/i });
		// Outline variant emits a `border` class; ghost has no border.
		expect(link.className).toMatch(/\bborder\b/);
	});

	it("navigates to / when clicked", async () => {
		server.use(
			http.get("http://localhost/v1/sessions/sess-1", () =>
				HttpResponse.json({ error: "not_found" }, { status: 404 }),
			),
			http.get("http://localhost/v1/sessions", () => HttpResponse.json(makeListSessionsResponse())),
		);
		const { router, ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		const link = await screen.findByRole("link", { name: /all sessions/i });
		fireEvent.click(link);
		await waitFor(() => expect(router.state.location.pathname).toBe("/"));
	});
});

describe("BackToReplaysLink", () => {
	it("renders 'All replays' with the outline variant once the replay loads", async () => {
		server.use(
			http.get("http://localhost/v1/replays/r-1", () =>
				HttpResponse.json(
					makeReplayRunResponse({
						id: "r-1",
						sourceSessionId: "sess-1",
						status: "failed",
						error: "boom",
					}),
				),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/replays/r-1"] });
		render(ui);
		const link = await screen.findByRole("link", { name: /all replays/i });
		expect(link.tagName).toBe("A");
		expect(link.className).toMatch(/\bborder\b/);
	});

	it("navigates to /sessions/:sourceSessionId?tab=replays when clicked", async () => {
		server.use(
			http.get("http://localhost/v1/replays/r-1", () =>
				HttpResponse.json(
					makeReplayRunResponse({
						id: "r-1",
						sourceSessionId: "sess-42",
						status: "failed",
						error: "boom",
					}),
				),
			),
			http.get("http://localhost/v1/sessions/sess-42", () =>
				HttpResponse.json(makeConversation({ id: "sess-42", agentId: "agent-42" })),
			),
			http.get("http://localhost/v1/sessions/sess-42/replays", () =>
				HttpResponse.json({ items: [] }),
			),
		);
		const { router, ui } = renderWithRouter({ initialEntries: ["/replays/r-1"] });
		render(ui);
		const link = await screen.findByRole("link", { name: /all replays/i });
		fireEvent.click(link);
		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/sessions/sess-42");
			expect(router.state.location.search).toEqual({ tab: "replays" });
		});
	});
});
