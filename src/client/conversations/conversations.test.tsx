import { HttpResponse, http } from "msw";

import {
	makeListSessionsResponse,
	makeSessionListItem,
} from "@/server/sessions/sessions.test-utils.ts";
import { server } from "@/test-server.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

// happy-dom must be registered before @testing-library/react evaluates — it
// reads `document` at module load. Dynamic import preserves that ordering.
registerHappyDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { renderWithRouter } = await import("../test-utils.tsx");

// Bun's test runner has no auto-cleanup hook — without this, the previous
// test's mounted component is still in the DOM and its in-flight fetch can
// hit MSW's handler reset, surfacing as an AbortError on the next test.
afterEach(() => cleanup());

const SESSIONS_URL = "http://localhost/v1/sessions";

describe("ConversationsList — empty state", () => {
	it("renders empty-state copy when the store has no sessions", async () => {
		server.use(http.get(SESSIONS_URL, () => HttpResponse.json(makeListSessionsResponse())));
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		expect(await screen.findByText(/no sessions yet/i)).toBeTruthy();
		// All three onboarding paths are documented — custom-loop devs are the
		// primary audience, but adapter-mode users need a pointer too.
		expect(screen.getByText(/pnpm dev:seed/i)).toBeTruthy();
		expect(screen.getByText(/\/v1\/sessions\/:id\/events/i)).toBeTruthy();
		expect(screen.getByText(/ELEVENLABS_API_KEY/i)).toBeTruthy();
	});
});

describe("ConversationsList — populated", () => {
	it("renders three sessions newest-first", async () => {
		const items = [
			makeSessionListItem({ id: "new", agentId: "agent-new" }),
			makeSessionListItem({ id: "mid", agentId: "agent-mid" }),
			makeSessionListItem({ id: "old", agentId: "agent-old" }),
		];
		server.use(
			http.get(SESSIONS_URL, () =>
				HttpResponse.json(makeListSessionsResponse({ sessions: items })),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		await waitFor(() => expect(screen.getByText("agent-new")).toBeTruthy());
		// Each row renders Agent / Duration / Source as a <dl>; the agent
		// values are the 1st, 4th, 7th <dd> across three rows.
		const dds = screen.getAllByRole("definition");
		const agentValues = dds.filter((_, i) => i % 3 === 0).map((n) => n.textContent);
		expect(agentValues).toEqual(["agent-new", "agent-mid", "agent-old"]);
	});

	it("renders the source tag for ingest and adapter sessions", async () => {
		server.use(
			http.get(SESSIONS_URL, () =>
				HttpResponse.json(
					makeListSessionsResponse({
						sessions: [
							makeSessionListItem({ id: "i", source: "ingest", agentId: "from-ingest" }),
							makeSessionListItem({
								id: "a",
								source: "adapter:elevenlabs",
								agentId: "from-eleven",
							}),
						],
					}),
				),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		await waitFor(() => expect(screen.getByText("from-ingest")).toBeTruthy());
		// The 3rd <dd> of each row is the source (Agent → Duration → Source).
		const dds = screen.getAllByRole("definition");
		const sources = dds.filter((_, i) => i % 3 === 2).map((n) => n.textContent);
		expect(sources).toEqual(["ingest", "adapter:elevenlabs"]);
	});

	it("renders 'in progress' for a session with no durationMs", async () => {
		server.use(
			http.get(SESSIONS_URL, () =>
				HttpResponse.json(
					makeListSessionsResponse({
						sessions: [makeSessionListItem({ durationMs: null, endedAt: null })],
					}),
				),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		await waitFor(() => expect(screen.getByText(/in progress/i)).toBeTruthy());
	});
});

describe("ConversationsList — pagination", () => {
	it("renders Load more when nextCursor is set and appends results on click", async () => {
		const page1 = makeListSessionsResponse({
			sessions: [makeSessionListItem({ id: "1", agentId: "first" })],
			nextCursor: "cursor-1",
		});
		const page2 = makeListSessionsResponse({
			sessions: [makeSessionListItem({ id: "2", agentId: "second" })],
			nextCursor: null,
		});
		server.use(
			http.get(SESSIONS_URL, ({ request }) => {
				const c = new URL(request.url).searchParams.get("cursor");
				return HttpResponse.json(c === "cursor-1" ? page2 : page1);
			}),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		const loadMore = await screen.findByRole("button", { name: /load more/i });
		fireEvent.click(loadMore);
		await waitFor(() => expect(screen.getByText("second")).toBeTruthy());
		// The first-page row is still on screen — pagination appends, not replaces.
		expect(screen.getByText("first")).toBeTruthy();
		// Final page reached → no more button.
		expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
	});
});

describe("ConversationsList — navigation", () => {
	it("navigates to /sessions/$sessionId when a row link is clicked", async () => {
		server.use(
			http.get(SESSIONS_URL, () =>
				HttpResponse.json(
					makeListSessionsResponse({
						sessions: [
							makeSessionListItem({ id: "sess-7", agentId: "agent-7" }),
							makeSessionListItem({ id: "sess-8", agentId: "agent-8" }),
						],
					}),
				),
			),
			http.get("http://localhost/v1/sessions/sess-8", () => HttpResponse.json({}, { status: 404 })),
		);
		const { router, ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		// The link's accessible name is the concatenation of its descendant
		// text (timestamp + agent id + duration + source). agent-8 uniquely
		// identifies the second row.
		const row = await screen.findByRole("link", { name: /agent-8/i });
		fireEvent.click(row);
		await waitFor(() => expect(router.state.location.pathname).toBe("/sessions/sess-8"));
	});

	it("renders a Replay button on each row", async () => {
		server.use(
			http.get(SESSIONS_URL, () =>
				HttpResponse.json(
					makeListSessionsResponse({
						sessions: [
							makeSessionListItem({ id: "s-1", agentId: "agent-1" }),
							makeSessionListItem({ id: "s-2", agentId: "agent-2" }),
						],
					}),
				),
			),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		await waitFor(() => expect(screen.getByText("agent-1")).toBeTruthy());
		const replayButtons = screen.getAllByRole("button", { name: /^replay session/i });
		expect(replayButtons).toHaveLength(2);
	});

	it("opens the replay modal when the row Replay button is clicked", async () => {
		server.use(
			http.get(SESSIONS_URL, () =>
				HttpResponse.json(
					makeListSessionsResponse({
						sessions: [makeSessionListItem({ id: "sess-7", agentId: "agent-7" })],
					}),
				),
			),
		);
		const { router, ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		const replay = await screen.findByRole("button", { name: /^replay session agent-7/i });
		fireEvent.click(replay);
		// Modal opens — its body contains the source session id.
		await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
		expect(screen.getByText("sess-7")).toBeTruthy();
		// Row click was suppressed via stopPropagation so the route did not change.
		expect(router.state.location.pathname).toBe("/");
	});
});

describe("ConversationsList — error path", () => {
	it("renders an alert when the server returns 500", async () => {
		server.use(http.get(SESSIONS_URL, () => HttpResponse.json({ error: "boom" }, { status: 500 })));
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		expect(await screen.findByRole("alert")).toBeTruthy();
	});

	it("renders an alert when the server returns a body with the wrong shape", async () => {
		// Confirms valibot safeParse + SessionsInvalidResponseError surfaces
		// schema drift through the same error-state UI as HTTP failures.
		server.use(http.get(SESSIONS_URL, () => HttpResponse.json({ nope: 1 })));
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		expect(await screen.findByRole("alert")).toBeTruthy();
	});

	it("recovers via the Try again button when the second fetch succeeds", async () => {
		let attempts = 0;
		server.use(
			http.get(SESSIONS_URL, () => {
				attempts += 1;
				if (attempts === 1) return HttpResponse.json({ error: "boom" }, { status: 500 });
				return HttpResponse.json(
					makeListSessionsResponse({ sessions: [makeSessionListItem({ agentId: "after-retry" })] }),
				);
			}),
		);
		const { ui } = renderWithRouter({ initialEntries: ["/"] });
		render(ui);
		const retry = await screen.findByRole("button", { name: /try again/i });
		fireEvent.click(retry);
		await waitFor(() => expect(screen.getByText("after-retry")).toBeTruthy());
		expect(attempts).toBe(2);
	});
});
