import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");

afterEach(() => cleanup());

describe("RootLayout", () => {
	it("renders the xray heading and description chrome on every route", async () => {
		server.use(
			http.get("http://localhost/v1/sessions", () =>
				HttpResponse.json({ sessions: [], nextCursor: null }),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		expect(await screen.findByRole("heading", { name: /^xray$/i, level: 1 })).toBeTruthy();
		expect(screen.getByText(/voice-agent debugger/i)).toBeTruthy();
	});

	it("renders the route's outlet content underneath the chrome", async () => {
		server.use(
			http.get("http://localhost/v1/sessions", () =>
				HttpResponse.json({ sessions: [], nextCursor: null }),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		// Outlet mounts <ConversationsList> at "/". Both should be present.
		await waitFor(() => expect(screen.getByText(/^conversations$/i)).toBeTruthy());
		expect(screen.getByRole("heading", { name: /^xray$/i })).toBeTruthy();
	});

	it("preserves the chrome on a not-found path", async () => {
		const { ui } = renderWithRouter({ initialEntries: ["/no-such-path"] });
		render(ui);
		expect(await screen.findByText(/page not found/i)).toBeTruthy();
		// Layout chrome still mounts above the NotFoundView.
		expect(screen.getByRole("heading", { name: /^xray$/i })).toBeTruthy();
	});
});
