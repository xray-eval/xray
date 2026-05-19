import {
	ConversationVersionNotFoundError,
	InvalidCompareSelectionError,
	InvalidReplayIdError,
	InvalidReplayRequestError,
	MalformedReplayBodyError,
	ReplayBodyTooLargeError,
	ReplayError,
	ReplayNotFoundError,
	ReplayStatusTransitionError,
} from "./replays.errors.ts";
import { describe, expect, it } from "bun:test";

describe("ReplayError subclasses", () => {
	it("InvalidReplayRequestError carries issues + name", () => {
		const e = new InvalidReplayRequestError([
			{
				kind: "schema",
				type: "x",
				input: undefined,
				expected: null,
				received: "undefined",
				message: "m",
			},
		]);
		expect(e).toBeInstanceOf(ReplayError);
		expect(e.name).toBe("InvalidReplayRequestError");
		expect(e.issues).toHaveLength(1);
	});
	it("MalformedReplayBodyError exposes a frozen issues array", () => {
		const e = new MalformedReplayBodyError();
		expect(e).toBeInstanceOf(ReplayError);
		expect(e.name).toBe("MalformedReplayBodyError");
		expect(e.issues[0]?.type).toBe("json_body");
	});
	it("InvalidReplayIdError carries issues", () => {
		const e = new InvalidReplayIdError([
			{
				kind: "schema",
				type: "x",
				input: undefined,
				expected: null,
				received: "undefined",
				message: "m",
			},
		]);
		expect(e.name).toBe("InvalidReplayIdError");
	});
	it("ReplayNotFoundError carries id", () => {
		const e = new ReplayNotFoundError("r");
		expect(e.replayId).toBe("r");
	});
	it("ConversationVersionNotFoundError carries id+version", () => {
		const e = new ConversationVersionNotFoundError("c", "v");
		expect(e.conversationId).toBe("c");
		expect(e.conversationVersion).toBe("v");
	});
	it("ReplayBodyTooLargeError carries maxBytes", () => {
		const e = new ReplayBodyTooLargeError(1024);
		expect(e.maxBytes).toBe(1024);
	});
	it("InvalidCompareSelectionError carries count/min/max", () => {
		const e = new InvalidCompareSelectionError(9, 2, 8);
		expect(e.count).toBe(9);
		expect(e.min).toBe(2);
		expect(e.max).toBe(8);
	});
	it("ReplayStatusTransitionError carries replayId/from/to", () => {
		const e = new ReplayStatusTransitionError("r", "failed", "completed");
		expect(e).toBeInstanceOf(ReplayError);
		expect(e.name).toBe("ReplayStatusTransitionError");
		expect(e.replayId).toBe("r");
		expect(e.from).toBe("failed");
		expect(e.to).toBe("completed");
	});
});
