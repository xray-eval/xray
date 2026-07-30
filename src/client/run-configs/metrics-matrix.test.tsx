import type { CompareRunConfigsResponse, ConversationScope } from "@/client/api/api.types.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { withRouter } = await import("../test-utils.tsx");
const { MetricsMatrix } = await import("./metrics-matrix.tsx");
const { makeRunConfigMetrics } = await import("./test-utils.ts");

afterEach(() => cleanup());

const BASELINE = "a".repeat(64);
const FAST = "b".repeat(64);

function comparison(
	over: Partial<CompareRunConfigsResponse> = {},
	scope: ConversationScope = "union",
): CompareRunConfigsResponse {
	return {
		replay_selection: "latest",
		conversation_scope: scope,
		union_conversations: 3,
		intersection_conversations: 2,
		groups: [
			{
				hash: BASELINE,
				name: "baseline",
				config: { model: "gpt-4o" },
				coverage: { conversations: 3, replays: 3, failed_replays: 1 },
				metrics: makeRunConfigMetrics({ ttft_ms: { avg: 400, p50: 380, p95: 900, n: 10 } }),
			},
			{
				hash: FAST,
				name: "fast-follow",
				config: { model: "gemini-2.5-flash" },
				coverage: { conversations: 2, replays: 2, failed_replays: 0 },
				metrics: makeRunConfigMetrics({ ttft_ms: { avg: 180, p50: 170, p95: 300, n: 10 } }),
			},
		],
		...over,
	};
}

/**
 * The matrix renders `<Link>`s, so it needs a router around it — and TanStack
 * Router mounts its tree asynchronously, so wait for the table before asserting.
 */
async function renderMatrix(value: CompareRunConfigsResponse) {
	render(withRouter(<MetricsMatrix comparison={value} />));
	await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
}

describe("MetricsMatrix", () => {
	it("keeps the column order the comparison returned", async () => {
		await renderMatrix(comparison());
		const headers = screen.getAllByRole("columnheader").map((h) => h.textContent ?? "");
		expect(headers[1]).toContain("baseline");
		expect(headers[2]).toContain("fast-follow");
	});

	it("marks the winning cell in a ranked row", async () => {
		await renderMatrix(comparison());
		const marked = screen.getAllByText("best");
		expect(marked).toHaveLength(1);
	});

	it("says a config 'ran' its share under union scope", async () => {
		await renderMatrix(comparison());
		expect(screen.getByText("ran 2/3")).toBeTruthy();
	});

	it("switches the verb under intersection, where coverage is a choice not a gap", async () => {
		// "ran 2 of 3" would be a plain untruth about a config that ran all 3 and
		// was narrowed by the user's own scope toggle.
		await renderMatrix(comparison({ conversation_scope: "intersection" }, "intersection"));
		expect(screen.getByText("compared on 2 of 3")).toBeTruthy();
		expect(screen.queryByText(/^ran /)).toBeNull();
	});

	it("carries the replay selection into the drill-down link", async () => {
		// Landing on a page that recomputed the metric under a different selection
		// silently changes the number the click was meant to explain.
		await renderMatrix(comparison({ replay_selection: "all" }));
		expect(screen.getByRole("link", { name: "baseline" }).getAttribute("href")).toBe(
			`/configs/${BASELINE}?replays=all`,
		);
	});

	it("surfaces a group's failed replays next to its coverage", async () => {
		await renderMatrix(comparison());
		expect(screen.getByText("1 failed")).toBeTruthy();
	});
});
