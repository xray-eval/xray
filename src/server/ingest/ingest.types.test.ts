import * as v from "valibot";

import { TurnCompletedEventSchema } from "./ingest.types.ts";
import { describe, expect, it } from "bun:test";

describe("TurnCompletedEventSchema", () => {
	it("parses an event with barge-in fields + responseLatencyMs", () => {
		const evt = {
			type: "turn_completed",
			idx: 0,
			role: "agent",
			text: "Sure, I can…",
			timestamp: "2026-05-16T12:00:01.000Z",
			responseLatencyMs: 400,
			interrupted: true,
			interruptedAtMs: 800,
		};
		expect(v.parse(TurnCompletedEventSchema, evt)).toMatchObject({
			responseLatencyMs: 400,
			interrupted: true,
			interruptedAtMs: 800,
		});
	});

	it("parses an event without any of the optional latency/barge-in fields", () => {
		const evt = {
			type: "turn_completed",
			idx: 0,
			role: "user",
			text: "hi",
			timestamp: "2026-05-16T12:00:01.000Z",
		};
		const out = v.parse(TurnCompletedEventSchema, evt);
		expect(out.responseLatencyMs).toBeUndefined();
		expect(out.interrupted).toBeUndefined();
		expect(out.interruptedAtMs).toBeUndefined();
	});

	it("rejects a negative interruptedAtMs", () => {
		const evt = {
			type: "turn_completed",
			idx: 0,
			role: "agent",
			text: "x",
			timestamp: "2026-05-16T12:00:01.000Z",
			interrupted: true,
			interruptedAtMs: -1,
		};
		expect(() => v.parse(TurnCompletedEventSchema, evt)).toThrow();
	});
});
