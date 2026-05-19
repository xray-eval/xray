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

const SAMPLE_CONVERSATIONS = {
	items: [
		{
			id: "conv-a",
			latestVersion: "v1",
			title: "Conversation A",
			createdAt: "2026-05-15T00:00:00.000Z",
			versions: 1,
			replays: 2,
		},
		{
			id: "conv-b",
			latestVersion: "v2",
			title: "Conversation B",
			createdAt: "2026-05-15T00:00:00.000Z",
			versions: 2,
			replays: 0,
		},
		{
			id: "conv-c",
			latestVersion: "v1",
			title: "Conversation C",
			createdAt: "2026-05-15T00:00:00.000Z",
			versions: 1,
			replays: 1,
		},
	],
};

function mockConversationsList(items: typeof SAMPLE_CONVERSATIONS = SAMPLE_CONVERSATIONS) {
	server.use(http.get("http://localhost/v1/conversations", () => HttpResponse.json(items)));
}

describe("ConversationsList", () => {
	it("renders one row per conversation in the response", async () => {
		mockConversationsList();
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);

		await waitFor(() => expect(screen.getByText("Conversation A")).toBeTruthy());
		expect(screen.getByText("Conversation B")).toBeTruthy();
		expect(screen.getByText("Conversation C")).toBeTruthy();
	});

	it("disables the Compare button until exactly two rows are selected", async () => {
		mockConversationsList();
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);

		const button = await waitFor(() => screen.getByRole("button", { name: /^Compare/ }));
		expect(button.hasAttribute("disabled")).toBe(true);

		const checkboxA = await waitFor(() =>
			screen.getByRole("checkbox", { name: /Select conversation conv-a/ }),
		);
		await act(async () => {
			fireEvent.click(checkboxA);
		});
		expect(button.hasAttribute("disabled")).toBe(true);

		const checkboxB = screen.getByRole("checkbox", { name: /Select conversation conv-b/ });
		await act(async () => {
			fireEvent.click(checkboxB);
		});
		await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));

		const checkboxC = screen.getByRole("checkbox", { name: /Select conversation conv-c/ });
		await act(async () => {
			fireEvent.click(checkboxC);
		});
		await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
	});

	it("exposes the exactly-two hint via aria-describedby", async () => {
		mockConversationsList();
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);

		const button = await waitFor(() => screen.getByRole("button", { name: /^Compare/ }));
		const hintId = button.getAttribute("aria-describedby");
		expect(hintId).toBeTruthy();
		const hint = hintId !== null ? document.getElementById(hintId) : null;
		expect(hint?.textContent).toMatch(/exactly two/i);
	});

	it("navigates to /compare/conversations with both ids when Compare clicks with two selected", async () => {
		mockConversationsList();
		const { ui, router } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);

		const checkboxA = await waitFor(() =>
			screen.getByRole("checkbox", { name: /Select conversation conv-a/ }),
		);
		await act(async () => {
			fireEvent.click(checkboxA);
		});
		const checkboxB = screen.getByRole("checkbox", { name: /Select conversation conv-b/ });
		await act(async () => {
			fireEvent.click(checkboxB);
		});

		const button = await waitFor(() => {
			const b = screen.getByRole("button", { name: /^Compare/ });
			if (b.hasAttribute("disabled")) throw new Error("still disabled");
			return b;
		});
		await act(async () => {
			fireEvent.click(button);
		});

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/compare/conversations"),
		);
		expect(router.state.location.search).toMatchObject({ ids: "conv-a:v1,conv-b:v2" });
	});
});
