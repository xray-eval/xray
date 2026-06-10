import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import type { ReplayDetailResponse } from "../../api/api.types.ts";
import { registerHappyDom } from "../../test-happy-dom.ts";
import { afterAll, afterEach, describe, expect, it } from "bun:test";

const REPLAY_ID = "44444444-4444-4444-4444-444444444444";

// happy-dom ships no EventSource. Install a minimal fake so the hook's
// `new EventSource(...)` resolves and the test can drive events. defineProperty
// (not an `as` cast) keeps the no-as-cast rule satisfied.
class FakeEventSource {
	static last: FakeEventSource | undefined;
	readonly url: string;
	closed = false;
	private readonly listeners = new Map<string, Set<() => void>>();
	constructor(url: string) {
		this.url = url;
		FakeEventSource.last = this;
	}
	addEventListener(type: string, fn: () => void): void {
		const set = this.listeners.get(type) ?? new Set<() => void>();
		set.add(fn);
		this.listeners.set(type, set);
	}
	removeEventListener(type: string, fn: () => void): void {
		this.listeners.get(type)?.delete(fn);
	}
	close(): void {
		this.closed = true;
	}
	dispatch(type: string): void {
		for (const fn of this.listeners.get(type) ?? []) fn();
	}
}

const realEventSource = globalThis.EventSource;
Object.defineProperty(globalThis, "EventSource", {
	configurable: true,
	writable: true,
	value: FakeEventSource,
});

registerHappyDom();
const { useQuery } = await import("@tanstack/react-query");
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { withQueryClient } = await import("../../test-utils.tsx");
const { useReplayLiveUpdates } = await import("./replay-live-updates.ts");
const { getReplay } = await import("../../api/api.ts");

afterEach(() => cleanup());
afterAll(() => {
	Object.defineProperty(globalThis, "EventSource", {
		configurable: true,
		writable: true,
		value: realEventSource,
	});
});

function buildReplay(overrides: Partial<ReplayDetailResponse> = {}): ReplayDetailResponse {
	return {
		id: REPLAY_ID,
		conversation_hash: "a".repeat(64),
		lifecycle_state: "analyzing",
		analysis_step: "metrics",
		failure_reason: null,
		started_at: "2026-05-15T10:00:00.000Z",
		finished_at: null,
		audio_path: null,
		job_id: null,
		run_config: null,
		turns: [],
		speech_segments: [],
		transcripts: [],
		turn_metrics: [],
		tool_calls: [],
		model_usage: [],
		spans: [],
		...overrides,
	};
}

// Mirrors the real Inspector: the hook lives in a child that only mounts once
// the replay query has data (like `ReplayBody`, rendered on query success), so
// it never sees a "loading" default lifecycle.
function Live({ lifecycle }: { lifecycle: ReplayDetailResponse["lifecycle_state"] }) {
	useReplayLiveUpdates(REPLAY_ID, lifecycle);
	return <div data-testid="state">{lifecycle}</div>;
}

function Harness() {
	const query = useQuery({
		queryKey: ["replays", { id: REPLAY_ID }],
		queryFn: ({ signal }) => getReplay(REPLAY_ID, signal),
	});
	if (query.data === undefined) return <div data-testid="state">loading</div>;
	return <Live lifecycle={query.data.lifecycle_state} />;
}

describe("useReplayLiveUpdates", () => {
	it("refetches on an SSE transition and closes the stream once terminal", async () => {
		let state: ReplayDetailResponse["lifecycle_state"] = "analyzing";
		server.use(
			http.get(`http://localhost/v1/replays/${REPLAY_ID}`, () =>
				HttpResponse.json(
					buildReplay({
						lifecycle_state: state,
						analysis_step: state === "analyzing" ? "metrics" : null,
					}),
				),
			),
		);

		render(withQueryClient(<Harness />));
		await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("analyzing"));

		const source = FakeEventSource.last;
		if (source === undefined) throw new Error("expected the hook to open an EventSource");
		expect(source.closed).toBe(false);

		// The server finished evaluating: the next fetch returns `completed`, and
		// the SSE event triggers the refetch that surfaces it.
		state = "completed";
		source.dispatch("evaluation_complete");

		await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("completed"));
		// Terminal now → the effect tears the stream down.
		await waitFor(() => expect(source.closed).toBe(true));
	});

	it("does not open a stream for an already-terminal replay", async () => {
		FakeEventSource.last = undefined;
		server.use(
			http.get(`http://localhost/v1/replays/${REPLAY_ID}`, () =>
				HttpResponse.json(buildReplay({ lifecycle_state: "completed", analysis_step: null })),
			),
		);

		render(withQueryClient(<Harness />));
		await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("completed"));
		expect(FakeEventSource.last).toBeUndefined();
	});
});
