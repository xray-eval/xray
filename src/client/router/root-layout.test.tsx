import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");

afterEach(() => cleanup());

describe("RootLayout", () => {
	it("renders the xray heading and minimal chrome tag on every route", async () => {
		server.use(
			http.get("http://localhost/v1/conversations", () => HttpResponse.json({ items: [] })),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		expect(await screen.findByRole("heading", { name: /^xray$/i, level: 1 })).toBeTruthy();
		expect(screen.getByText(/voice-agent debugger/i)).toBeTruthy();
	});

	it("renders the route's outlet content underneath the chrome", async () => {
		server.use(
			http.get("http://localhost/v1/conversations", () => HttpResponse.json({ items: [] })),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		// Query the heading, not the text: the header nav also links to
		// "Conversations", so a bare text query matches the chrome as well as the
		// outlet and can't tell you the route actually rendered.
		await waitFor(() =>
			expect(screen.getByRole("heading", { name: /^conversations$/i })).toBeTruthy(),
		);
		expect(screen.getByRole("heading", { name: /^xray$/i })).toBeTruthy();
	});

	it("marks the nav link for the current route as active", async () => {
		server.use(http.get("http://localhost/v1/run-configs", () => HttpResponse.json({ items: [] })));
		const { ui } = renderWithRouter({ initialEntries: ["/configs"] });
		render(ui);
		const configsLink = await waitFor(() => screen.getByRole("link", { name: "Run configs" }));
		expect(configsLink.getAttribute("data-active")).toBe("true");
		expect(
			screen.getByRole("link", { name: "Conversations" }).getAttribute("data-active"),
		).toBeNull();
	});

	it("preserves the chrome on a not-found path", async () => {
		const { ui } = renderWithRouter({ initialEntries: ["/no-such-path"] });
		render(ui);
		expect(await screen.findByText(/page not found/i)).toBeTruthy();
		expect(screen.getByRole("heading", { name: /^xray$/i })).toBeTruthy();
	});
});
