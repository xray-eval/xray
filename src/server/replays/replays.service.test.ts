import { applyEvent } from "@/server/ingest/ingest.service.ts";
import {
	makeSessionStartedEvent,
	makeToolCalledEvent,
	makeTurnCompletedEvent,
} from "@/server/ingest/ingest.test-utils.ts";
import { getReplayRun } from "@/server/store/replay-runs-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";
import { listToolCallsForSession } from "@/server/store/tool-calls-repo.ts";
import { listTurnsForSession } from "@/server/store/turns-repo.ts";

import {
	SourceSessionNotFoundError,
	WebhookHttpError,
	WebhookResponseShapeError,
} from "./replays.errors.ts";
import type { WebhookFetch } from "./replays.service.ts";
import { createReplay, runReplay } from "./replays.service.ts";
import { makeWebhookResponse } from "./replays.test-utils.ts";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

let store: Store;

beforeEach(() => {
	store = makeTempStore();
});

afterEach(() => {
	store.close();
});

/** Seed a source session with N user/agent turn pairs. */
function seedSource(sessionId: string, pairs: { user: string; agent: string }[]): void {
	applyEvent(store, sessionId, makeSessionStartedEvent({ agentId: "src-agent" }));
	pairs.forEach((p, i) => {
		applyEvent(
			store,
			sessionId,
			makeTurnCompletedEvent({
				idx: i * 2,
				role: "user",
				text: p.user,
				timestamp: `2026-05-16T12:0${i * 2}:00.000Z`,
			}),
		);
		applyEvent(
			store,
			sessionId,
			makeTurnCompletedEvent({
				idx: i * 2 + 1,
				role: "agent",
				text: p.agent,
				timestamp: `2026-05-16T12:0${i * 2 + 1}:00.000Z`,
			}),
		);
	});
}

type WebhookResponseFixture =
	| Record<string, unknown>
	| ((url: string, init: RequestInit) => Response | Promise<Response>);

function mockFetch(response: WebhookResponseFixture): WebhookFetch {
	return mock(async (url: string, init: RequestInit) =>
		typeof response === "function"
			? response(url, init)
			: new Response(JSON.stringify(response), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
	);
}

describe("createReplay", () => {
	it("inserts a pending row with a deterministic-shaped id", async () => {
		seedSource("src-1", [{ user: "hi", agent: "hello" }]);
		const result = createReplay(store, {
			sourceSessionId: "src-1",
			webhookUrl: "https://example.test/wh",
		});
		expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(result.targetSessionId).toMatch(/^replay-[0-9a-f-]{36}$/);
		const row = getReplayRun(store.db, result.id);
		expect(row?.status).toBe("pending");
		expect(row?.sourceSessionId).toBe("src-1");
		expect(row?.progressTotal).toBe(1);
	});

	it("throws SourceSessionNotFoundError when the source session doesn't exist", () => {
		expect(() =>
			createReplay(store, {
				sourceSessionId: "missing",
				webhookUrl: "https://example.test/wh",
			}),
		).toThrow(SourceSessionNotFoundError);
	});

	it("counts user turns as the progress_total", () => {
		seedSource("src-1", [
			{ user: "u1", agent: "a1" },
			{ user: "u2", agent: "a2" },
			{ user: "u3", agent: "a3" },
		]);
		const result = createReplay(store, {
			sourceSessionId: "src-1",
			webhookUrl: "https://example.test/wh",
		});
		expect(getReplayRun(store.db, result.id)?.progressTotal).toBe(3);
	});
});

describe("runReplay — happy path", () => {
	it("walks user turns, posts to the webhook, writes replies to the target session", async () => {
		seedSource("src-1", [
			{ user: "hello", agent: "hi back" },
			{ user: "how are you", agent: "fine, thanks" },
		]);
		const { id, targetSessionId } = createReplay(store, {
			sourceSessionId: "src-1",
			webhookUrl: "https://example.test/wh",
		});

		const fetchImpl = mockFetch((_url, init) => {
			const body = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify(
					makeWebhookResponse({ agentText: `echo:${body.userText}`, responseLatencyMs: 120 }),
				),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		await runReplay({ store, runId: id, fetchImpl });

		const run = getReplayRun(store.db, id);
		expect(run?.status).toBe("completed");
		expect(run?.progressCompleted).toBe(2);
		expect(run?.finishedAt).not.toBeNull();
		expect(run?.error).toBeNull();

		const turns = listTurnsForSession(store.db, targetSessionId);
		expect(turns.map((t) => t.role)).toEqual(["user", "agent", "user", "agent"]);
		expect(turns.map((t) => t.text)).toEqual([
			"hello",
			"echo:hello",
			"how are you",
			"echo:how are you",
		]);
		// Latency lands on the agent turns.
		const agentTurns = turns.filter((t) => t.role === "agent");
		expect(agentTurns.map((t) => t.responseLatencyMs)).toEqual([120, 120]);
	});

	it("passes history (turns before the current user turn) to the webhook", async () => {
		seedSource("src-1", [
			{ user: "hello", agent: "hi" },
			{ user: "follow up", agent: "ok" },
		]);
		const { id } = createReplay(store, {
			sourceSessionId: "src-1",
			webhookUrl: "https://example.test/wh",
		});

		const seenHistories: unknown[] = [];
		const fetchImpl = mockFetch((_url, init) => {
			const body = JSON.parse(String(init?.body));
			seenHistories.push(body.history);
			return new Response(JSON.stringify(makeWebhookResponse()), { status: 200 });
		});

		await runReplay({ store, runId: id, fetchImpl });

		// First turn: empty history. Second turn: [user:hello, agent:hi].
		expect(seenHistories[0]).toEqual([]);
		expect(seenHistories[1]).toEqual([
			{ role: "user", text: "hello" },
			{ role: "agent", text: "hi" },
		]);
	});

	it("includes the source's recorded tool results for the matching agent turn", async () => {
		applyEvent(store, "src-1", makeSessionStartedEvent({ agentId: "x" }));
		applyEvent(
			store,
			"src-1",
			makeTurnCompletedEvent({ idx: 0, role: "user", text: "what's the weather" }),
		);
		applyEvent(
			store,
			"src-1",
			makeTurnCompletedEvent({ idx: 1, role: "agent", text: "let me check" }),
		);
		applyEvent(
			store,
			"src-1",
			makeToolCalledEvent({
				turnIdx: 1,
				idx: 0,
				name: "get_weather",
				args: { city: "Paris" },
				result: { temp: 22, unit: "C" },
			}),
		);

		const { id } = createReplay(store, {
			sourceSessionId: "src-1",
			webhookUrl: "https://example.test/wh",
		});

		let seenBody: { recordedToolResults?: unknown } | undefined;
		const fetchImpl = mockFetch((_url, init) => {
			seenBody = JSON.parse(String(init?.body));
			return new Response(JSON.stringify(makeWebhookResponse()), { status: 200 });
		});

		await runReplay({ store, runId: id, fetchImpl });

		expect(seenBody?.recordedToolResults).toEqual([
			{ name: "get_weather", args: { city: "Paris" }, result: { temp: 22, unit: "C" } },
		]);
	});

	it("writes webhook-returned tool calls into the target session", async () => {
		seedSource("src-1", [{ user: "do a thing", agent: "ok" }]);
		const { id, targetSessionId } = createReplay(store, {
			sourceSessionId: "src-1",
			webhookUrl: "https://example.test/wh",
		});

		const fetchImpl = mockFetch(
			makeWebhookResponse({
				agentText: "calling tool",
				toolCalls: [
					{ name: "do_thing", args: { x: 1 } },
					{ name: "do_thing", args: { x: 2 } },
				],
			}),
		);

		await runReplay({ store, runId: id, fetchImpl });

		const toolCalls = listToolCallsForSession(store.db, targetSessionId);
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls.map((tc) => tc.name)).toEqual(["do_thing", "do_thing"]);
		expect(toolCalls.map((tc) => JSON.parse(tc.argsJson))).toEqual([{ x: 1 }, { x: 2 }]);
	});
});

describe("runReplay — failure modes", () => {
	it("marks the run failed and surfaces the status when the webhook returns 500", async () => {
		seedSource("src-1", [{ user: "hi", agent: "hello" }]);
		const { id } = createReplay(store, {
			sourceSessionId: "src-1",
			webhookUrl: "https://example.test/wh",
		});

		const fetchImpl = mockFetch(() => new Response("boom", { status: 500 }));

		await expect(runReplay({ store, runId: id, fetchImpl })).rejects.toThrow(WebhookHttpError);

		const run = getReplayRun(store.db, id);
		expect(run?.status).toBe("failed");
		expect(run?.error).toContain("500");
	});

	it("marks the run failed when the webhook returns a malformed body", async () => {
		seedSource("src-1", [{ user: "hi", agent: "hello" }]);
		const { id } = createReplay(store, {
			sourceSessionId: "src-1",
			webhookUrl: "https://example.test/wh",
		});

		// Missing required `agentText` field.
		const fetchImpl = mockFetch({ wat: 1 });

		await expect(runReplay({ store, runId: id, fetchImpl })).rejects.toThrow(
			WebhookResponseShapeError,
		);

		expect(getReplayRun(store.db, id)?.status).toBe("failed");
	});

	it("transitions pending → running before the first webhook call", async () => {
		// Tests that the worker flips status before any I/O — needed so a UI
		// polling progress sees the right state during the call.
		seedSource("src-1", [{ user: "hi", agent: "hello" }]);
		const { id } = createReplay(store, {
			sourceSessionId: "src-1",
			webhookUrl: "https://example.test/wh",
		});

		let statusAtFetchTime: string | undefined;
		const fetchImpl = mockFetch(() => {
			statusAtFetchTime = getReplayRun(store.db, id)?.status;
			return new Response(JSON.stringify(makeWebhookResponse()), { status: 200 });
		});

		await runReplay({ store, runId: id, fetchImpl });
		expect(statusAtFetchTime).toBe("running");
	});
});

describe("runReplay — edge cases", () => {
	it("completes a source session with no user turns by emitting an empty target", async () => {
		// Source only has an agent turn — nothing to POST. Marks completed
		// with zero progress so the UI doesn't show it hung.
		applyEvent(store, "src-1", makeSessionStartedEvent({ agentId: "x" }));
		applyEvent(
			store,
			"src-1",
			makeTurnCompletedEvent({ idx: 0, role: "agent", text: "monologue" }),
		);

		const { id, targetSessionId } = createReplay(store, {
			sourceSessionId: "src-1",
			webhookUrl: "https://example.test/wh",
		});

		const fetchImpl = mockFetch({});
		await runReplay({ store, runId: id, fetchImpl });

		expect(getReplayRun(store.db, id)?.status).toBe("completed");
		expect(getReplayRun(store.db, id)?.progressCompleted).toBe(0);
		expect(listTurnsForSession(store.db, targetSessionId)).toEqual([]);
	});

	it("updates progress incrementally as each turn completes", async () => {
		seedSource("src-1", [
			{ user: "u1", agent: "a1" },
			{ user: "u2", agent: "a2" },
			{ user: "u3", agent: "a3" },
		]);
		const { id } = createReplay(store, {
			sourceSessionId: "src-1",
			webhookUrl: "https://example.test/wh",
		});

		const observed: number[] = [];
		const fetchImpl = mockFetch(() => {
			observed.push(getReplayRun(store.db, id)?.progressCompleted ?? -1);
			return new Response(JSON.stringify(makeWebhookResponse()), { status: 200 });
		});

		await runReplay({ store, runId: id, fetchImpl });

		// Progress is bumped AFTER each successful POST, so the observed values
		// during the call itself are 0, 1, 2 (count of *previously-finished* turns).
		expect(observed).toEqual([0, 1, 2]);
		expect(getReplayRun(store.db, id)?.progressCompleted).toBe(3);
	});
});
