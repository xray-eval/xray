import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import type { RunConfigMetrics } from "../api/api.types.ts";
import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");

afterEach(() => cleanup());

const CONFIG_HASH = "a".repeat(64);
const CONVERSATION_HASH = "b".repeat(64);
const LATEST_REPLAY = "11111111-1111-1111-1111-111111111111";
const EARLIER_REPLAY = "22222222-2222-2222-2222-222222222222";

function metrics(over: Partial<RunConfigMetrics> = {}): RunConfigMetrics {
	return {
		ttft_ms: { avg: 250, p50: 240, p95: 900, n: 12 },
		agent_response_ms: { avg: 600, p50: 580, p95: 1200, n: 8 },
		model_latency_ms: { avg: null, p50: null, p95: null, n: 0 },
		yield_ms: { avg: null, p50: null, p95: null, n: 0 },
		interruption: { interrupted_turns: 1, agent_turns: 4 },
		tokens: { avg_input: null, avg_output: null, avg_total: null, n: 0 },
		pass: { passed: 1, total: 1 },
		...over,
	};
}

function mockDetail(replays: { id: string; started_at: string; passed: boolean | null }[]) {
	server.use(
		http.get(`http://localhost/v1/run-configs/${CONFIG_HASH}`, ({ request }) => {
			const selection = new URL(request.url).searchParams.get("replay_selection");
			return HttpResponse.json({
				hash: CONFIG_HASH,
				name: "baseline",
				config: { model: "gpt-4o", temperature: 0.5 },
				created_at: "2026-07-01T00:00:00.000Z",
				replay_selection: selection ?? "latest",
				coverage: { conversations: 1, replays: replays.length, failed_replays: 1 },
				metrics: metrics(),
				conversations: [
					{
						conversation_hash: CONVERSATION_HASH,
						conversation_name: "books a table",
						replay_id: replays[0]?.id ?? LATEST_REPLAY,
						replays,
						metrics: metrics(),
					},
				],
			});
		}),
	);
}

const ONE_REPLAY = [{ id: LATEST_REPLAY, started_at: "2026-07-02T10:00:00.000Z", passed: true }];

describe("RunConfigDetail", () => {
	it("links each conversation row to the replay its numbers came from", async () => {
		mockDetail(ONE_REPLAY);
		const { ui } = renderWithRouter({ initialEntries: [`/configs/${CONFIG_HASH}`] });
		render(ui);

		const link = await waitFor(() => screen.getByRole("link", { name: "books a table" }));
		expect(link.getAttribute("href")).toBe(`/replays/${LATEST_REPLAY}`);
	});

	it("offers an explicit Listen affordance pointing at the same replay", async () => {
		mockDetail(ONE_REPLAY);
		const { ui } = renderWithRouter({ initialEntries: [`/configs/${CONFIG_HASH}`] });
		render(ui);

		const listen = await waitFor(() => screen.getByRole("link", { name: "Listen" }));
		expect(listen.getAttribute("href")).toBe(`/replays/${LATEST_REPLAY}`);
	});

	it("also links the conversation spec, secondary to the audio", async () => {
		mockDetail(ONE_REPLAY);
		const { ui } = renderWithRouter({ initialEntries: [`/configs/${CONFIG_HASH}`] });
		render(ui);

		const specLink = await waitFor(() => screen.getByRole("link", { name: /^spec/ }));
		expect(specLink.getAttribute("href")).toBe(`/conversations/${CONVERSATION_HASH}`);
	});

	it("keeps earlier runs individually reachable instead of collapsing them", async () => {
		mockDetail([
			...ONE_REPLAY,
			{ id: EARLIER_REPLAY, started_at: "2026-07-01T10:00:00.000Z", passed: false },
		]);
		const { ui } = renderWithRouter({
			initialEntries: [`/configs/${CONFIG_HASH}?replays=all`],
		});
		render(ui);

		await waitFor(() => expect(screen.getByText(/1 earlier run/)).toBeTruthy());
		const links = screen.getAllByRole("link");
		const hrefs = links.map((link) => link.getAttribute("href"));
		expect(hrefs).toContain(`/replays/${EARLIER_REPLAY}`);
	});

	it("renders the config as key/value pairs plus the group label", async () => {
		mockDetail(ONE_REPLAY);
		const { ui } = renderWithRouter({ initialEntries: [`/configs/${CONFIG_HASH}`] });
		render(ui);

		await waitFor(() => expect(screen.getByRole("heading", { name: "baseline" })).toBeTruthy());
		expect(screen.getByText("model=")).toBeTruthy();
		expect(screen.getByText("gpt-4o")).toBeTruthy();
	});

	it("shows the sample size next to every metric", async () => {
		mockDetail(ONE_REPLAY);
		const { ui } = renderWithRouter({ initialEntries: [`/configs/${CONFIG_HASH}`] });
		render(ui);

		await waitFor(() => expect(screen.getAllByText("n=12").length).toBeGreaterThan(0));
		expect(screen.getAllByText("n=0").length).toBeGreaterThan(0);
	});

	it("surfaces a load failure instead of rendering an empty page", async () => {
		server.use(
			http.get(`http://localhost/v1/run-configs/${CONFIG_HASH}`, () =>
				HttpResponse.json({ error: "run_config_not_found" }, { status: 404 }),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: [`/configs/${CONFIG_HASH}`] });
		render(ui);

		await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
	});
});
