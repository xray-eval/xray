import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");
const { alignTurnsByKey, parseConversationPairs } = await import("./compare-conversations.tsx");

afterEach(() => cleanup());

function mockConversation(id: string, version: string, turns: object[], title: string | null) {
	server.use(
		http.get(`http://localhost/v1/conversations/${id}`, ({ request }) => {
			const url = new URL(request.url);
			if (url.searchParams.get("version") !== version) {
				return HttpResponse.json({ error: "not_found" }, { status: 404 });
			}
			return HttpResponse.json({
				id,
				version,
				title,
				createdAt: "2026-05-15T00:00:00.000Z",
				turns,
			});
		}),
	);
}

describe("parseConversationPairs", () => {
	it("parses two id:version pairs from a comma-separated query value", () => {
		expect(parseConversationPairs("a:v1,b:v2")).toEqual([
			{ conversationId: "a", version: "v1" },
			{ conversationId: "b", version: "v2" },
		]);
	});

	it("returns empty for undefined or empty input", () => {
		expect(parseConversationPairs(undefined)).toEqual([]);
		expect(parseConversationPairs("")).toEqual([]);
	});

	it("skips malformed segments without a colon", () => {
		expect(parseConversationPairs("a:v1,malformed,b:v2")).toEqual([
			{ conversationId: "a", version: "v1" },
			{ conversationId: "b", version: "v2" },
		]);
	});
});

describe("alignTurnsByKey", () => {
	it("aligns turns with matching keys into one row each, marking matched=true", () => {
		const rows = alignTurnsByKey([
			{
				id: "a",
				version: "v1",
				title: null,
				createdAt: "2026-05-15T00:00:00.000Z",
				turns: [
					{ role: "user", key: "greet", text: "hi" },
					{ role: "agent", key: "respond", text: "hello" },
				],
			},
			{
				id: "b",
				version: "v1",
				title: null,
				createdAt: "2026-05-15T00:00:00.000Z",
				turns: [
					{ role: "user", key: "greet", text: "yo" },
					{ role: "agent", key: "respond", text: "hi back" },
				],
			},
		]);
		expect(rows.map((r) => r.key)).toEqual(["greet", "respond"]);
		expect(rows[0]?.matched).toBe(true);
		expect(rows[1]?.matched).toBe(true);
	});

	it("emits a row for every distinct key; unmatched cells are undefined and matched=false", () => {
		const rows = alignTurnsByKey([
			{
				id: "a",
				version: "v1",
				title: null,
				createdAt: "2026-05-15T00:00:00.000Z",
				turns: [
					{ role: "user", key: "greet", text: "hi" },
					{ role: "agent", key: "only-a", text: "alone" },
				],
			},
			{
				id: "b",
				version: "v1",
				title: null,
				createdAt: "2026-05-15T00:00:00.000Z",
				turns: [
					{ role: "user", key: "greet", text: "yo" },
					{ role: "agent", key: "only-b", text: "alone" },
				],
			},
		]);
		expect(rows.map((r) => r.key)).toEqual(["greet", "only-a", "only-b"]);
		const onlyA = rows.find((r) => r.key === "only-a");
		const onlyB = rows.find((r) => r.key === "only-b");
		expect(onlyA?.matched).toBe(false);
		expect(onlyA?.cells[0]?.text).toBe("alone");
		expect(onlyA?.cells[1]).toBeUndefined();
		expect(onlyB?.matched).toBe(false);
		expect(onlyB?.cells[0]).toBeUndefined();
		expect(onlyB?.cells[1]?.text).toBe("alone");
	});
});

describe("CompareConversations route", () => {
	it("renders both conversations and the alignment ratio when the ids query is valid", async () => {
		mockConversation(
			"a",
			"v1",
			[
				{ role: "user", key: "greet", text: "hi" },
				{ role: "agent", key: "respond", text: "hello" },
			],
			"Title A",
		);
		mockConversation(
			"b",
			"v1",
			[
				{ role: "user", key: "greet", text: "yo" },
				{ role: "agent", key: "only-b", text: "different" },
			],
			"Title B",
		);

		const { ui } = renderWithRouter({
			initialEntries: ["/compare/conversations?ids=a:v1,b:v1"],
		});
		render(ui);

		await waitFor(() => expect(screen.getByText("Title A")).toBeTruthy());
		expect(screen.getByText("Title B")).toBeTruthy();

		const summary = await waitFor(() => screen.getByTestId("match-summary"));
		expect(summary.textContent).toMatch(/1 of 3 turns matched \(33%\)/);
	});

	it("renders a 'no matching turn' placeholder cell for unmatched keys", async () => {
		mockConversation(
			"a",
			"v1",
			[
				{ role: "user", key: "greet", text: "hi" },
				{ role: "agent", key: "only-a", text: "alone" },
			],
			null,
		);
		mockConversation(
			"b",
			"v1",
			[{ role: "user", key: "greet", text: "yo" }],
			null,
		);

		const { ui } = renderWithRouter({
			initialEntries: ["/compare/conversations?ids=a:v1,b:v1"],
		});
		render(ui);

		await waitFor(() => expect(screen.getAllByText(/no matching turn/i).length).toBeGreaterThan(0));
	});

	it("surfaces an error when the ids query does not contain exactly two pairs", async () => {
		const { ui } = renderWithRouter({
			initialEntries: ["/compare/conversations?ids=a:v1"],
		});
		render(ui);

		await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/exactly 2/));
	});
});
