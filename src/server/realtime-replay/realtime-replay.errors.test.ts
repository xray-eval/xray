import type { BaseIssue } from "valibot";

import {
	AgentTurnTooLargeError,
	ContentTypeChangedMidTurnError,
	InvalidRealtimeReplayRequestError,
	RealtimeReplayError,
	TooManyToolCallsError,
	UnknownAudioExtensionError,
	UnknownTurnIdxError,
	WebhookClosedEarlyError,
	WebhookConnectError,
	WebhookInvalidFrameError,
	WebhookMalformedFrameError,
	WebhookReportedError,
} from "./realtime-replay.errors.ts";
import { describe, expect, it } from "bun:test";

function fakeIssues(message: string): readonly BaseIssue<unknown>[] {
	return [
		{
			kind: "schema",
			type: "test",
			input: undefined,
			expected: "(anything)",
			received: "(nothing)",
			message,
		},
	] satisfies readonly BaseIssue<unknown>[];
}

describe("RealtimeReplayError subclasses", () => {
	it("InvalidRealtimeReplayRequestError carries issues and is an instance of RealtimeReplayError", () => {
		const issues = fakeIssues("bad");
		const err = new InvalidRealtimeReplayRequestError(issues);
		expect(err).toBeInstanceOf(RealtimeReplayError);
		expect(err.name).toBe("InvalidRealtimeReplayRequestError");
		expect(err.issues).toBe(issues);
	});

	it("WebhookConnectError carries the URL on the field and a wrapped cause, but does NOT interpolate the URL into the message", () => {
		const cause = new Error("ECONNREFUSED");
		const err = new WebhookConnectError("wss://example.test/?token=secret", "refused", { cause });
		expect(err).toBeInstanceOf(RealtimeReplayError);
		expect(err.name).toBe("WebhookConnectError");
		expect(err.webhookUrl).toBe("wss://example.test/?token=secret");
		expect(err.cause).toBe(cause);
		expect(err.message).toContain("refused");
		// Token-in-URL must not flow into the message (which lands in the
		// replay_runs.error column, the API response, and container logs).
		expect(err.message).not.toContain("token=secret");
		expect(err.message).not.toContain("example.test");
	});

	it("WebhookClosedEarlyError surfaces code, reason, and progress", () => {
		const err = new WebhookClosedEarlyError(2, 5, 1011, "bye");
		expect(err.name).toBe("WebhookClosedEarlyError");
		expect(err.turnsCompleted).toBe(2);
		expect(err.turnsExpected).toBe(5);
		expect(err.code).toBe(1011);
		expect(err.reason).toBe("bye");
		expect(err.message).toContain("1011");
		expect(err.message).toContain("2/5");
	});

	it("WebhookInvalidFrameError carries the Valibot issues", () => {
		const issues = fakeIssues("missing transcript");
		const err = new WebhookInvalidFrameError(issues);
		expect(err.name).toBe("WebhookInvalidFrameError");
		expect(err.issues).toBe(issues);
	});

	it("WebhookMalformedFrameError wraps the parse cause", () => {
		const cause = new SyntaxError("Unexpected token");
		const err = new WebhookMalformedFrameError({ cause });
		expect(err.name).toBe("WebhookMalformedFrameError");
		expect(err.cause).toBe(cause);
	});

	it("WebhookReportedError exposes the code", () => {
		const err = new WebhookReportedError("no_api_key", "missing");
		expect(err.name).toBe("WebhookReportedError");
		expect(err.code).toBe("no_api_key");
		expect(err.message).toContain("no_api_key");
		expect(err.message).toContain("missing");
	});

	it("UnknownTurnIdxError carries turnIdx", () => {
		const e = new UnknownTurnIdxError(99);
		expect(e.name).toBe("UnknownTurnIdxError");
		expect(e.turnIdx).toBe(99);
	});

	it("ContentTypeChangedMidTurnError surfaces both content types", () => {
		const err = new ContentTypeChangedMidTurnError(1, "audio/wav", "audio/opus");
		expect(err.name).toBe("ContentTypeChangedMidTurnError");
		expect(err.first).toBe("audio/wav");
		expect(err.conflicting).toBe("audio/opus");
		expect(err.message).toContain("audio/wav");
		expect(err.message).toContain("audio/opus");
	});

	it("AgentTurnTooLargeError carries bytes + limit", () => {
		const err = new AgentTurnTooLargeError(3, 2_000_000, 1_500_000);
		expect(err).toBeInstanceOf(RealtimeReplayError);
		expect(err.name).toBe("AgentTurnTooLargeError");
		expect(err.turnIdx).toBe(3);
		expect(err.bytes).toBe(2_000_000);
		expect(err.limit).toBe(1_500_000);
		expect(err.message).toContain("3");
		expect(err.message).toContain("1500000");
	});

	it("TooManyToolCallsError carries the cap", () => {
		const err = new TooManyToolCallsError(5, 64);
		expect(err).toBeInstanceOf(RealtimeReplayError);
		expect(err.name).toBe("TooManyToolCallsError");
		expect(err.turnIdx).toBe(5);
		expect(err.limit).toBe(64);
		expect(err.message).toContain("64");
	});

	it("UnknownAudioExtensionError carries extension + path", () => {
		const err = new UnknownAudioExtensionError("flac", "sess-1/0.flac");
		expect(err).toBeInstanceOf(RealtimeReplayError);
		expect(err.name).toBe("UnknownAudioExtensionError");
		expect(err.extension).toBe("flac");
		expect(err.path).toBe("sess-1/0.flac");
		expect(err.message).toContain("flac");
	});
});
