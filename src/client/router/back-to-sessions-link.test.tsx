import { HttpResponse, http } from "msw";

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

	it("navigates to / when clicked", async () => {
		server.use(
			http.get("http://localhost/v1/sessions/sess-1", () =>
				HttpResponse.json({ error: "not_found" }, { status: 404 }),
			),
			http.get("http://localhost/v1/sessions", () =>
				HttpResponse.json({ sessions: [], nextCursor: null }),
			),
		);
		const { router, ui } = renderWithRouter({ initialEntries: ["/sessions/sess-1"] });
		render(ui);
		const link = await screen.findByRole("link", { name: /all sessions/i });
		fireEvent.click(link);
		await waitFor(() => expect(router.state.location.pathname).toBe("/"));
	});
});
