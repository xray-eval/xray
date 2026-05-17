import { HttpResponse, http } from "msw";

import { makeReplayRunResponse } from "@/server/replays/replays.test-utils.ts";
import { server } from "@/test-server.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { ReplayModal } = await import("./replay-modal.tsx");
const { withQueryClient } = await import("../test-utils.tsx");

afterEach(() => cleanup());

beforeEach(() => {
	// Wipe both prefill keys between tests so realtime/text URLs don't leak.
	try {
		window.localStorage.removeItem("xray.replay.webhookUrl");
		window.localStorage.removeItem("xray.replay.realtimeWebhookUrl");
	} catch {
		// happy-dom may throw when storage is disabled; test isolation still holds.
	}
});

const REPLAYS_URL = "http://localhost/v1/replays";
const REALTIME_REPLAYS_URL = "http://localhost/v1/replays/realtime";

describe("ReplayModal — render", () => {
	it("renders with the source session id in the body", () => {
		render(
			withQueryClient(
				<ReplayModal sourceSessionId="sess-source" onClose={mock()} onStarted={mock()} />,
			),
		);
		expect(screen.getByText("sess-source")).toBeTruthy();
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	it("disables submit until a webhook URL is typed", () => {
		render(
			withQueryClient(<ReplayModal sourceSessionId="s" onClose={mock()} onStarted={mock()} />),
		);
		const submit = screen.getByRole("button", { name: /run replay/i });
		if (!(submit instanceof HTMLButtonElement)) throw new Error("expected button");
		expect(submit.disabled).toBe(true);
		const input = screen.getByLabelText(/webhook url/i);
		if (!(input instanceof HTMLInputElement)) throw new Error("expected input");
		fireEvent.change(input, { target: { value: "https://example.test/wh" } });
		expect(submit.disabled).toBe(false);
	});
});

describe("ReplayModal — submit", () => {
	it("POSTs to /v1/replays and calls onStarted with the run", async () => {
		server.use(
			http.post(REPLAYS_URL, () =>
				HttpResponse.json(makeReplayRunResponse({ id: "r-99" }), { status: 202 }),
			),
		);
		const onStarted = mock();
		render(
			withQueryClient(
				<ReplayModal sourceSessionId="sess-1" onClose={mock()} onStarted={onStarted} />,
			),
		);
		fireEvent.change(screen.getByLabelText(/webhook url/i), {
			target: { value: "https://example.test/wh" },
		});
		fireEvent.click(screen.getByRole("button", { name: /run replay/i }));
		await waitFor(() => expect(onStarted).toHaveBeenCalled());
		expect(onStarted.mock.calls[0]?.[0].id).toBe("r-99");
	});

	it("sends sourceSessionId and webhookUrl in the request body", async () => {
		const seen = mock();
		server.use(
			http.post(REPLAYS_URL, async ({ request }) => {
				seen(await request.json());
				return HttpResponse.json(makeReplayRunResponse(), { status: 202 });
			}),
		);
		render(
			withQueryClient(<ReplayModal sourceSessionId="sess-1" onClose={mock()} onStarted={mock()} />),
		);
		fireEvent.change(screen.getByLabelText(/webhook url/i), {
			target: { value: "https://example.test/wh" },
		});
		fireEvent.click(screen.getByRole("button", { name: /run replay/i }));
		await waitFor(() => expect(seen).toHaveBeenCalled());
		expect(seen.mock.calls[0]?.[0]).toEqual({
			sourceSessionId: "sess-1",
			webhookUrl: "https://example.test/wh",
		});
	});

	it("renders an alert when the server returns 4xx and does not call onStarted", async () => {
		server.use(
			http.post(REPLAYS_URL, () =>
				HttpResponse.json({ error: "source_session_not_found" }, { status: 404 }),
			),
		);
		const onStarted = mock();
		render(
			withQueryClient(
				<ReplayModal sourceSessionId="missing" onClose={mock()} onStarted={onStarted} />,
			),
		);
		fireEvent.change(screen.getByLabelText(/webhook url/i), {
			target: { value: "https://example.test/wh" },
		});
		fireEvent.click(screen.getByRole("button", { name: /run replay/i }));
		await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
		expect(onStarted).not.toHaveBeenCalled();
	});

	it("persists the webhook URL on successful submit", async () => {
		server.use(
			http.post(REPLAYS_URL, () => HttpResponse.json(makeReplayRunResponse(), { status: 202 })),
		);
		render(
			withQueryClient(<ReplayModal sourceSessionId="s" onClose={mock()} onStarted={mock()} />),
		);
		fireEvent.change(screen.getByLabelText(/webhook url/i), {
			target: { value: "https://persisted.example/wh" },
		});
		fireEvent.click(screen.getByRole("button", { name: /run replay/i }));
		await waitFor(() =>
			expect(window.localStorage.getItem("xray.replay.webhookUrl")).toBe(
				"https://persisted.example/wh",
			),
		);
	});
});

describe("ReplayModal — realtime mode", () => {
	it("POSTs to /v1/replays/realtime when the realtime mode is picked", async () => {
		const seen = mock();
		server.use(
			http.post(REALTIME_REPLAYS_URL, async ({ request }) => {
				seen(await request.json());
				return HttpResponse.json(makeReplayRunResponse({ mode: "realtime" }), { status: 202 });
			}),
		);
		const onStarted = mock();
		render(
			withQueryClient(
				<ReplayModal sourceSessionId="sess-1" onClose={mock()} onStarted={onStarted} />,
			),
		);
		fireEvent.click(screen.getByRole("radio", { name: /realtime/i }));
		fireEvent.change(screen.getByLabelText(/webhook url/i), {
			target: { value: "wss://example.test/realtime" },
		});
		fireEvent.click(screen.getByRole("button", { name: /run replay/i }));
		await waitFor(() => expect(onStarted).toHaveBeenCalled());
		expect(seen.mock.calls[0]?.[0]).toEqual({
			sourceSessionId: "sess-1",
			webhookUrl: "wss://example.test/realtime",
		});
	});

	it("persists the realtime webhook URL under its own storage key", async () => {
		server.use(
			http.post(REALTIME_REPLAYS_URL, () =>
				HttpResponse.json(makeReplayRunResponse({ mode: "realtime" }), { status: 202 }),
			),
		);
		render(
			withQueryClient(<ReplayModal sourceSessionId="s" onClose={mock()} onStarted={mock()} />),
		);
		fireEvent.click(screen.getByRole("radio", { name: /realtime/i }));
		fireEvent.change(screen.getByLabelText(/webhook url/i), {
			target: { value: "wss://persisted.example/realtime" },
		});
		fireEvent.click(screen.getByRole("button", { name: /run replay/i }));
		await waitFor(() =>
			expect(window.localStorage.getItem("xray.replay.realtimeWebhookUrl")).toBe(
				"wss://persisted.example/realtime",
			),
		);
		// Text key untouched.
		expect(window.localStorage.getItem("xray.replay.webhookUrl")).toBeNull();
	});
});

describe("ReplayModal — close", () => {
	it("fires onClose when the shadcn close button is clicked", () => {
		const onClose = mock();
		render(
			withQueryClient(<ReplayModal sourceSessionId="s" onClose={onClose} onStarted={mock()} />),
		);
		// shadcn's DialogContent renders a built-in close button with `<span class="sr-only">Close</span>`.
		fireEvent.click(screen.getByRole("button", { name: /close/i }));
		expect(onClose).toHaveBeenCalled();
	});

	it("fires onClose when Cancel is clicked", () => {
		const onClose = mock();
		render(
			withQueryClient(<ReplayModal sourceSessionId="s" onClose={onClose} onStarted={mock()} />),
		);
		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		expect(onClose).toHaveBeenCalled();
	});
});
