import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");
const { alignTurnsByKey, parseConversationHashes } = await import("./compare-conversations.tsx");

afterEach(() => cleanup());

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function mockConversation(hash: string, turns: object[], name: string) {
	server.use(
		http.get(`http://localhost/v1/conversations/${hash}`, () =>
			HttpResponse.json({
				hash,
				name,
				created_at: "2026-05-15T00:00:00.000Z",
				last_run_at: "2026-05-15T00:00:00.000Z",
				turns,
			}),
		),
	);
}

describe("parseConversationHashes", () => {
	it("parses two 64-char hex hashes from a comma-separated query value", () => {
		expect(parseConversationHashes(`${HASH_A},${HASH_B}`)).toEqual([HASH_A, HASH_B]);
	});

	it("returns empty for undefined or empty input", () => {
		expect(parseConversationHashes(undefined)).toEqual([]);
		expect(parseConversationHashes("")).toEqual([]);
	});

	it("skips malformed segments that aren't 64-char hex", () => {
		expect(parseConversationHashes(`${HASH_A},not-a-hash,${HASH_B}`)).toEqual([HASH_A, HASH_B]);
	});
});

describe("alignTurnsByKey", () => {
	it("aligns turns with matching keys into one row each, marking matched=true", () => {
		const rows = alignTurnsByKey([
			{
				hash: HASH_A,
				name: "A",
				created_at: "2026-05-15T00:00:00.000Z",
				last_run_at: "2026-05-15T00:00:00.000Z",
				turns: [
					{ role: "user", key: "greet", text: "hi" },
					{ role: "agent", key: "respond", text: "hello" },
				],
			},
			{
				hash: HASH_B,
				name: "B",
				created_at: "2026-05-15T00:00:00.000Z",
				last_run_at: "2026-05-15T00:00:00.000Z",
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

	it("emits a row for every distinct key; unmatched cells are undefined", () => {
		const rows = alignTurnsByKey([
			{
				hash: HASH_A,
				name: "A",
				created_at: "2026-05-15T00:00:00.000Z",
				last_run_at: "2026-05-15T00:00:00.000Z",
				turns: [
					{ role: "user", key: "greet", text: "hi" },
					{ role: "agent", key: "only-a", text: "alone" },
				],
			},
			{
				hash: HASH_B,
				name: "B",
				created_at: "2026-05-15T00:00:00.000Z",
				last_run_at: "2026-05-15T00:00:00.000Z",
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
			HASH_A,
			[
				{ role: "user", key: "greet", text: "hi" },
				{ role: "agent", key: "respond", text: "hello" },
			],
			"Conversation A",
		);
		mockConversation(
			HASH_B,
			[
				{ role: "user", key: "greet", text: "yo" },
				{ role: "agent", key: "only-b", text: "different" },
			],
			"Conversation B",
		);

		const { ui } = renderWithRouter({
			initialEntries: [`/compare/conversations?ids=${HASH_A},${HASH_B}`],
		});
		render(ui);

		await waitFor(() => expect(screen.getByText("Conversation A")).toBeTruthy());
		expect(screen.getByText("Conversation B")).toBeTruthy();

		const summary = await waitFor(() => screen.getByTestId("match-summary"));
		expect(summary.textContent).toMatch(/1 of 3 turns matched \(33%\)/);
	});

	it("renders a 'no matching turn' placeholder cell for unmatched keys", async () => {
		mockConversation(
			HASH_A,
			[
				{ role: "user", key: "greet", text: "hi" },
				{ role: "agent", key: "only-a", text: "alone" },
			],
			"A",
		);
		mockConversation(HASH_B, [{ role: "user", key: "greet", text: "yo" }], "B");

		const { ui } = renderWithRouter({
			initialEntries: [`/compare/conversations?ids=${HASH_A},${HASH_B}`],
		});
		render(ui);

		await waitFor(() => expect(screen.getAllByText(/no matching turn/i).length).toBeGreaterThan(0));
	});

	it("surfaces an error when the ids query does not contain exactly two hashes", async () => {
		const { ui } = renderWithRouter({
			initialEntries: [`/compare/conversations?ids=${HASH_A}`],
		});
		render(ui);

		await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/exactly 2/));
	});
});
