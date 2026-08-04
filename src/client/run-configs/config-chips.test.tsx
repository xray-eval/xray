import type { ReplaySelection } from "@/client/api/api.types.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { withRouter } = await import("../test-utils.tsx");
const { ConfigChips } = await import("./config-chips.tsx");
const { makeRunConfigGroupResult, makeRunConfigMetrics } = await import("./test-utils.ts");
const { splitConfigFacets } = await import("./config-facets.ts");

afterEach(() => cleanup());

/**
 * Facets from the groups under comparison, the way `CompareBody` derives them.
 *
 * Each card links to its config's page, so this needs a router — and TanStack
 * Router mounts asynchronously. Awaiting the slot rather than a card is what
 * lets the empty case prove the router mounted *and* rendered no cards.
 */
async function renderChips(
	groups: readonly ReturnType<typeof makeRunConfigGroupResult>[],
	onRemove: (hash: string) => void = () => undefined,
	replaySelection: ReplaySelection = "latest",
) {
	render(
		withRouter(
			<div data-testid="chips-slot">
				<ConfigChips
					groups={groups}
					facets={splitConfigFacets(groups)}
					replaySelection={replaySelection}
					onRemove={onRemove}
				/>
			</div>,
		),
	);
	return await waitFor(() => screen.getByTestId("chips-slot"));
}

const A = "a".repeat(64);
const B = "b".repeat(64);

const GROUPS = [
	makeRunConfigGroupResult({
		hash: A,
		name: "baseline",
		coverage: { conversations: 3, replays: 4, failed_replays: 1 },
		metrics: makeRunConfigMetrics({
			pass: { passed: 3, total: 4 },
			assertions: { passed: 15, total: 20 },
			judges: { passed: 2, total: 4 },
			agent_response_ms: { avg: 820, p50: 800, p95: 1200, n: 12 },
		}),
	}),
	makeRunConfigGroupResult({
		hash: B,
		name: "fast-follow",
		coverage: { conversations: 3, replays: 3, failed_replays: 0 },
		metrics: makeRunConfigMetrics({ pass: { passed: 3, total: 3 } }),
	}),
];

describe("ConfigChips", () => {
	it("carries each config's headline numbers, so the row is readable without the grids", async () => {
		await renderChips(GROUPS);

		const baseline = screen.getByRole("listitem", { name: /baseline/ });
		// Judge and assertion rates side by side: a config can pass every
		// deterministic check and still be judged wrong, and the pair is what
		// says which kind of failure this is.
		expect(baseline.textContent).toContain("50%");
		expect(baseline.textContent).toContain("75%");
		expect(baseline.textContent).toContain("800ms");
	});

	it("reports how many replays a number rests on", async () => {
		await renderChips(GROUPS);
		expect(screen.getByRole("listitem", { name: /baseline/ }).textContent).toContain("4");
	});

	it("flags a config with failed replays, which the pass rate alone hides", async () => {
		await renderChips(GROUPS);

		expect(screen.getByRole("listitem", { name: /baseline/ }).textContent).toContain("1 failed");
		expect(screen.getByRole("listitem", { name: /fast-follow/ }).textContent).not.toContain(
			"failed",
		);
	});

	it("reports the config the user dropped", async () => {
		const removed: string[] = [];
		await renderChips(GROUPS, (hash) => removed.push(hash));
		fireEvent.click(screen.getByRole("button", { name: "Remove baseline from comparison" }));

		expect(removed).toEqual([A]);
	});

	it("tells two unnamed configs apart by what actually differs between them", async () => {
		// The regression this guards: `runConfigLabel` joins every pair and cuts at
		// 64 chars, so configs sharing a long prefix all rendered the same string —
		// and the remove buttons all got the same accessible name, leaving no way
		// to say which card you meant.
		const shared = "openai_gpt5_6_luna_preview_2026_07_14_high_reasoning";
		const groups = [
			makeRunConfigGroupResult({ hash: A, config: { ai_model: shared, temperature: "0.2" } }),
			makeRunConfigGroupResult({ hash: B, config: { ai_model: shared, temperature: "0.9" } }),
		];
		await renderChips(groups);

		expect(
			screen.getByRole("button", { name: "Remove temperature=0.2 from comparison" }),
		).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Remove temperature=0.9 from comparison" }),
		).toBeDefined();
	});

	it("keeps the dev's name when there is one, since that outranks any derived label", async () => {
		await renderChips(GROUPS);
		expect(screen.getByRole("button", { name: "Remove baseline from comparison" })).toBeDefined();
	});

	it("falls back to the hash when two configs are distinguished by nothing", async () => {
		// Same config content under two group hashes shouldn't happen (the hash is
		// derived from the content), but a label of "" would be unclickable.
		const groups = [
			makeRunConfigGroupResult({ hash: A, config: { model: "gpt-5" } }),
			makeRunConfigGroupResult({ hash: B, config: { model: "gpt-5" } }),
		];
		await renderChips(groups);

		expect(screen.getAllByRole("button", { name: /^Remove \w+ from comparison$/ })).toHaveLength(2);
	});

	it("opens the config's own page from the card", async () => {
		// The card is the always-visible per-config surface, so it has to carry the
		// drill-down. The aggregate table's column header used to be the only route
		// there, and it now sits behind a collapsed disclosure.
		await renderChips(GROUPS);
		expect(screen.getByRole("link", { name: "baseline" }).getAttribute("href")).toBe(
			`/configs/${A}?replays=latest`,
		);
	});

	it("carries the replay selection into the drill-down", async () => {
		// Landing on a page that recomputed the number under a different selection
		// silently changes the number being explained.
		await renderChips(GROUPS, () => undefined, "all");
		expect(screen.getByRole("link", { name: "baseline" }).getAttribute("href")).toBe(
			`/configs/${A}?replays=all`,
		);
	});

	it("renders nothing when nothing is selected", async () => {
		const slot = await renderChips([]);
		expect(slot.textContent).toBe("");
	});
});
