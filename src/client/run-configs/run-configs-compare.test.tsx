import { HttpResponse, http } from "msw";
import * as v from "valibot";

import { CompareRunConfigsRequestSchema } from "@/server/run-configs/run-configs.types.ts";
import { server } from "@/test-server.ts";

import type { RunConfigMetrics, RunConfigSummary } from "../api/api.types.ts";
import { registerHappyDom } from "../test-happy-dom.ts";
import { resolveSelection } from "./run-configs-compare.tsx";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");

afterEach(() => cleanup());

const BASELINE = "a".repeat(64);
const FAST = "b".repeat(64);

function metrics(over: Partial<RunConfigMetrics> = {}): RunConfigMetrics {
	return {
		ttft_ms: { avg: null, p50: null, p95: null, n: 0 },
		agent_response_ms: { avg: null, p50: null, p95: null, n: 0 },
		model_latency_ms: { avg: null, p50: null, p95: null, n: 0 },
		yield_ms: { avg: null, p50: null, p95: null, n: 0 },
		interruption: { interrupted_turns: 0, agent_turns: 0 },
		tokens: { avg_input: null, avg_output: null, avg_total: null, n: 0 },
		pass: { passed: 0, total: 0 },
		...over,
	};
}

const GROUPS = [
	{
		hash: FAST,
		name: "fast-follow",
		config: { model: "gemini-2.5-flash" },
		created_at: "2026-07-02T00:00:00.000Z",
		last_run_at: "2026-07-02T00:00:00.000Z",
		coverage: { conversations: 1, replays: 1, failed_replays: 0 },
	},
	{
		hash: BASELINE,
		name: "baseline",
		config: { model: "gpt-4o" },
		created_at: "2026-07-01T00:00:00.000Z",
		last_run_at: "2026-07-01T00:00:00.000Z",
		coverage: { conversations: 2, replays: 3, failed_replays: 1 },
	},
] satisfies RunConfigSummary[];

interface CompareOptions {
	readonly unionConversations?: number;
	readonly intersectionConversations?: number;
	readonly fastConversations?: number;
}

function mockApi(options: CompareOptions = {}) {
	const union = options.unionConversations ?? 2;
	server.use(
		http.get("http://localhost/v1/run-configs", () => HttpResponse.json({ items: GROUPS })),
		http.post("http://localhost/v1/run-configs/compare", async ({ request }) => {
			// Parse with the server's own schema rather than casting: the mock then
			// also asserts the client sends a body the real route would accept.
			const body = v.parse(CompareRunConfigsRequestSchema, await request.json());
			return HttpResponse.json({
				replay_selection: body.replay_selection,
				conversation_scope: body.conversation_scope,
				union_conversations: union,
				intersection_conversations: options.intersectionConversations ?? 1,
				groups: body.config_hashes.map((hash) => ({
					hash,
					name: hash === BASELINE ? "baseline" : "fast-follow",
					config: { model: hash === BASELINE ? "gpt-4o" : "gemini-2.5-flash" },
					coverage: {
						conversations: hash === BASELINE ? union : (options.fastConversations ?? union),
						replays: 2,
						failed_replays: hash === BASELINE ? 1 : 0,
					},
					metrics: metrics({
						ttft_ms:
							hash === BASELINE
								? { avg: 400, p50: 380, p95: 900, n: 10 }
								: { avg: 180, p50: 170, p95: 300, n: 10 },
					}),
				})),
			});
		}),
	);
}

/** `count` distinct sha256-shaped hashes, stable across calls. */
function manyHashes(count: number): string[] {
	return Array.from({ length: count }, (_, i) =>
		String(i + 1)
			.repeat(64)
			.slice(0, 64),
	);
}

function mockManyConfigs(count: number) {
	const hashes = manyHashes(count);
	const groups = hashes.map((hash, i) => ({
		hash,
		name: `config-${i + 1}`,
		config: { model: `m-${i + 1}` },
		created_at: "2026-07-01T00:00:00.000Z",
		last_run_at: "2026-07-01T00:00:00.000Z",
		coverage: { conversations: 1, replays: 1, failed_replays: 0 },
	})) satisfies RunConfigSummary[];

	server.use(
		http.get("http://localhost/v1/run-configs", () => HttpResponse.json({ items: groups })),
		http.post("http://localhost/v1/run-configs/compare", async ({ request }) => {
			const body = v.parse(CompareRunConfigsRequestSchema, await request.json());
			return HttpResponse.json({
				replay_selection: body.replay_selection,
				conversation_scope: body.conversation_scope,
				union_conversations: 1,
				intersection_conversations: 1,
				groups: body.config_hashes.map((hash) => ({
					hash,
					name: `config-${hashes.indexOf(hash) + 1}`,
					config: { model: "m" },
					coverage: { conversations: 1, replays: 1, failed_replays: 0 },
					metrics: metrics(),
				})),
			});
		}),
	);
}

describe("RunConfigsCompare", () => {
	it("compares the two most recent configs when the URL names none", async () => {
		mockApi();
		const { ui } = renderWithRouter({ initialEntries: ["/configs"] });
		render(ui);

		await waitFor(() => expect(screen.getByLabelText("Run config comparison")).toBeTruthy());
		expect(screen.getByRole("link", { name: "baseline" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "fast-follow" })).toBeTruthy();
	});

	it("marks the winning cell only where a direction means better", async () => {
		mockApi();
		const { ui } = renderWithRouter({ initialEntries: [`/configs?ids=${BASELINE},${FAST}`] });
		render(ui);

		await waitFor(() => expect(screen.getByLabelText("Run config comparison")).toBeTruthy());
		// fast-follow's 180ms TTFT beats baseline's 400ms, and it's the only row
		// where both configs reported a comparable number.
		const bestMarkers = screen.getAllByText("best");
		expect(bestMarkers).toHaveLength(1);
		expect(screen.getByText("180ms")).toBeTruthy();
	});

	it("shows each metric's sample size", async () => {
		mockApi();
		const { ui } = renderWithRouter({ initialEntries: [`/configs?ids=${BASELINE},${FAST}`] });
		render(ui);

		await waitFor(() => expect(screen.getAllByText("n=10").length).toBe(2));
		expect(screen.getAllByText("n=0").length).toBeGreaterThan(0);
	});

	it("warns when the configs did not run the same conversations", async () => {
		mockApi({ unionConversations: 3, intersectionConversations: 1, fastConversations: 1 });
		const { ui } = renderWithRouter({ initialEntries: [`/configs?ids=${BASELINE},${FAST}`] });
		render(ui);

		await waitFor(() =>
			expect(screen.getByText(/didn't all run the same conversations/)).toBeTruthy(),
		);
		expect(screen.getByRole("button", { name: "Compare shared only" })).toBeTruthy();
	});

	it("stays quiet about coverage when every config ran everything", async () => {
		mockApi({ unionConversations: 2, intersectionConversations: 2, fastConversations: 2 });
		const { ui } = renderWithRouter({ initialEntries: [`/configs?ids=${BASELINE},${FAST}`] });
		render(ui);

		await waitFor(() => expect(screen.getByLabelText("Run config comparison")).toBeTruthy());
		expect(screen.queryByText(/didn't all run the same conversations/)).toBeNull();
	});

	it("switches to the shared-conversations scope from the warning", async () => {
		mockApi({ unionConversations: 3, intersectionConversations: 1, fastConversations: 1 });
		const { ui, router } = renderWithRouter({
			initialEntries: [`/configs?ids=${BASELINE},${FAST}`],
		});
		render(ui);

		const button = await waitFor(() => screen.getByRole("button", { name: "Compare shared only" }));
		await act(async () => {
			fireEvent.click(button);
		});
		await waitFor(() => expect(router.state.location.search.scope).toBe("intersection"));
	});

	it("puts the replay-selection mode in the URL so a comparison is shareable", async () => {
		mockApi();
		const { ui, router } = renderWithRouter({
			initialEntries: [`/configs?ids=${BASELINE},${FAST}`],
		});
		render(ui);

		const allCompleted = await waitFor(() => screen.getByRole("button", { name: "All completed" }));
		await act(async () => {
			fireEvent.click(allCompleted);
		});
		await waitFor(() => expect(router.state.location.search.replays).toBe("all"));
	});

	it("does not claim a config 'ran' fewer conversations than it did under the shared scope", async () => {
		// Both columns are narrowed to the shared subset, so "ran 1/3" would be a
		// literal untruth about a config that ran all three.
		mockApi({ unionConversations: 3, intersectionConversations: 1, fastConversations: 1 });
		const { ui } = renderWithRouter({
			initialEntries: [`/configs?ids=${BASELINE},${FAST}&scope=intersection`],
		});
		render(ui);

		await waitFor(() => expect(screen.getByLabelText("Run config comparison")).toBeTruthy());
		expect(screen.queryByText(/^ran /)).toBeNull();
		expect(screen.getAllByText(/compared on \d+ of 3/).length).toBeGreaterThan(0);
	});

	it("keeps the 'ran X/Y' wording under the default scope", async () => {
		mockApi({ unionConversations: 3, intersectionConversations: 1, fastConversations: 1 });
		const { ui } = renderWithRouter({ initialEntries: [`/configs?ids=${BASELINE},${FAST}`] });
		render(ui);

		await waitFor(() => expect(screen.getByText("ran 3/3")).toBeTruthy());
		expect(screen.getByText("ran 1/3")).toBeTruthy();
	});

	it("links each column header to that config's drill-down", async () => {
		mockApi();
		const { ui } = renderWithRouter({ initialEntries: [`/configs?ids=${BASELINE},${FAST}`] });
		render(ui);

		const link = await waitFor(() => screen.getByRole("link", { name: "baseline" }));
		expect(link.getAttribute("href")).toBe(`/configs/${BASELINE}`);
	});

	it("says why the remaining configs went un-clickable at the selection cap", async () => {
		// Eight greyed-out cards with no explanation reads as "the page broke",
		// not "you're at the maximum".
		mockManyConfigs(9);
		const ids = manyHashes(9).slice(0, 8).join(",");
		const { ui } = renderWithRouter({ initialEntries: [`/configs?ids=${ids}`] });
		render(ui);

		await waitFor(() =>
			expect(screen.getByText(/Comparing the maximum of 8 configs/)).toBeTruthy(),
		);
	});

	it("stays quiet about the cap below it", async () => {
		mockManyConfigs(9);
		const ids = manyHashes(9).slice(0, 3).join(",");
		const { ui } = renderWithRouter({ initialEntries: [`/configs?ids=${ids}`] });
		render(ui);

		await waitFor(() => expect(screen.getByLabelText("Run config comparison")).toBeTruthy());
		expect(screen.queryByText(/Comparing the maximum of/)).toBeNull();
	});

	it("tells the dev how to create a config group when none exist", async () => {
		server.use(http.get("http://localhost/v1/run-configs", () => HttpResponse.json({ items: [] })));
		const { ui } = renderWithRouter({ initialEntries: ["/configs"] });
		render(ui);

		await waitFor(() => expect(screen.getByText(/No run configs yet/)).toBeTruthy());
	});

	it("asks for a second config instead of prompting a selection that can't be made", async () => {
		// The state every dev is in right after their first labelled run. There is
		// no second card to click, so "select at least 2" would be an instruction
		// with nothing to act on.
		server.use(
			http.get("http://localhost/v1/run-configs", () => HttpResponse.json({ items: [GROUPS[1]] })),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/configs"] });
		render(ui);

		await waitFor(() => expect(screen.getByText(/Only one run config so far/)).toBeTruthy());
		expect(screen.getByText(/baseline/)).toBeTruthy();
		expect(screen.queryByText(/Select at least/)).toBeNull();
	});

	it("does not offer the shared-only switch when the configs share no conversations", async () => {
		// Switching to `intersection` over a disjoint pair lands on a matrix where
		// every cell is "—" with n=0, so the one-click fix would be a dead end.
		mockApi({ unionConversations: 3, intersectionConversations: 0, fastConversations: 1 });
		const { ui } = renderWithRouter({ initialEntries: [`/configs?ids=${BASELINE},${FAST}`] });
		render(ui);

		await waitFor(() => expect(screen.getByText(/no conversations in common/)).toBeTruthy());
		expect(screen.queryByRole("button", { name: "Compare shared only" })).toBeNull();
	});

	it("surfaces a list failure rather than an empty page", async () => {
		server.use(
			http.get("http://localhost/v1/run-configs", () =>
				HttpResponse.json({ error: "boom" }, { status: 500 }),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/configs"] });
		render(ui);

		await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
	});
});

describe("resolveSelection", () => {
	it("defaults to the two most recently active configs", () => {
		expect(resolveSelection(undefined, GROUPS)).toEqual([FAST, BASELINE]);
	});

	it("keeps the order the URL asked for", () => {
		expect(resolveSelection(`${BASELINE},${FAST}`, GROUPS)).toEqual([BASELINE, FAST]);
	});

	it("drops hashes that no longer exist rather than requesting a 404", () => {
		expect(resolveSelection(`${BASELINE},${"f".repeat(64)}`, GROUPS)).toEqual([BASELINE]);
	});

	it("de-duplicates a repeated hash", () => {
		expect(resolveSelection(`${BASELINE},${BASELINE}`, GROUPS)).toEqual([BASELINE]);
	});

	it("falls back to the default when every requested hash is unknown", () => {
		expect(resolveSelection("nonsense", GROUPS)).toEqual([FAST, BASELINE]);
	});
});
