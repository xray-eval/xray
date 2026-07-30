import { HttpResponse, http } from "msw";
import * as v from "valibot";

import { ReplaySelectionSchema } from "@/server/run-configs/run-configs.types.ts";
import { server } from "@/test-server.ts";

import type { RunConfigMetrics } from "../api/api.types.ts";
import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");
const { makeRunConfigMetrics } = await import("./test-utils.ts");

afterEach(() => cleanup());

const CONFIG_HASH = "a".repeat(64);
const CONVERSATION_HASH = "b".repeat(64);
const LATEST_REPLAY = "11111111-1111-1111-1111-111111111111";
const EARLIER_REPLAY = "22222222-2222-2222-2222-222222222222";

/** This page's baseline: TTFT and voice-to-voice measured, the rest absent. */
function metrics(over: Partial<RunConfigMetrics> = {}): RunConfigMetrics {
	return makeRunConfigMetrics({
		ttft_ms: { avg: 250, p50: 240, p95: 900, n: 12 },
		agent_response_ms: { avg: 600, p50: 580, p95: 1200, n: 8 },
		interruption: { interrupted_turns: 1, agent_turns: 4 },
		pass: { passed: 1, total: 1 },
		...over,
	});
}

function mockDetail(
	replays: { id: string; started_at: string; passed: boolean | null }[],
	groupReplays = replays.length,
) {
	server.use(
		http.get(`http://localhost/v1/run-configs/${CONFIG_HASH}`, ({ request }) => {
			const raw = new URL(request.url).searchParams.get("replay_selection");
			// Validated with the server's own schema rather than echoed back: the
			// real route 400s an unknown selection, and a mock that echoes would
			// hide a client sending one.
			const selection = raw === null ? null : v.parse(ReplaySelectionSchema, raw);
			return HttpResponse.json({
				hash: CONFIG_HASH,
				name: "baseline",
				config: { model: "gpt-4o", temperature: 0.5 },
				created_at: "2026-07-01T00:00:00.000Z",
				replay_selection: selection ?? "latest",
				// Group-wide, exactly as `listRunConfigs` counts it for the card.
				coverage: { conversations: 1, replays: groupReplays, failed_replays: 1 },
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

	it("says the pass badge covers only the newest run when the metrics don't", async () => {
		// Under `all` the badge reads the newest replay while the pass-rate cell
		// beside it averages every one, so an unqualified green "passed" can sit
		// directly above "1 of 2 replays".
		mockDetail([
			...ONE_REPLAY,
			{ id: EARLIER_REPLAY, started_at: "2026-07-01T10:00:00.000Z", passed: false },
		]);
		const { ui } = renderWithRouter({
			initialEntries: [`/configs/${CONFIG_HASH}?replays=all`],
		});
		render(ui);

		await waitFor(() => expect(screen.getByText("latest passed")).toBeTruthy());
	});

	it("leaves the badge unqualified under the latest selection, where it covers everything", async () => {
		mockDetail(ONE_REPLAY);
		const { ui } = renderWithRouter({ initialEntries: [`/configs/${CONFIG_HASH}`] });
		render(ui);

		await waitFor(() => expect(screen.getByText("passed")).toBeTruthy());
		expect(screen.queryByText("latest passed")).toBeNull();
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

	it("says what the aggregate covers when the selection excludes runs", async () => {
		// The header counts the whole group, same as the card that linked here.
		// Without this line the metrics silently describe a subset of it.
		mockDetail(ONE_REPLAY, 4);
		const { ui } = renderWithRouter({ initialEntries: [`/configs/${CONFIG_HASH}`] });
		render(ui);

		await waitFor(() => expect(screen.getByText(/1 of 4 replays/)).toBeTruthy());
	});

	it("does not caveat the aggregate when it already covers every replay", async () => {
		mockDetail(ONE_REPLAY, 1);
		const { ui } = renderWithRouter({ initialEntries: [`/configs/${CONFIG_HASH}`] });
		render(ui);

		await waitFor(() => expect(screen.getByText("Across every conversation")).toBeTruthy());
		// The pass-rate cell also renders "1 of 1 replays", so match the caveat's
		// own conversations clause rather than the replay count.
		expect(screen.queryByText(/of \d+ conversations/)).toBeNull();
	});

	it("ignores an unknown replay selection rather than erroring the page", async () => {
		// A stale bookmark or a hand-edited URL should land on the default view,
		// not on "Failed to load this run config."
		mockDetail(ONE_REPLAY);
		const { ui } = renderWithRouter({
			initialEntries: [`/configs/${CONFIG_HASH}?replays=nonsense`],
		});
		render(ui);

		await waitFor(() => expect(screen.getByRole("heading", { name: "baseline" })).toBeTruthy());
		expect(screen.queryByRole("alert")).toBeNull();
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
