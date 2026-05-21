import type { ReplayEvent } from "./replays.events.ts";
import { makeReplayEvents } from "./replays.events.ts";
import { describe, expect, it } from "bun:test";

describe("ReplayEvents", () => {
	it("delivers an emitted event to a subscribed listener", () => {
		const events = makeReplayEvents();
		const seen: ReplayEvent[] = [];
		const off = events.subscribe("r1", (e) => {
			seen.push(e);
		});
		events.emit("r1", { type: "state", lifecycle_state: "analyzing", analysis_step: "vad" });
		expect(seen).toHaveLength(1);
		off();
	});

	it("does not deliver to listeners subscribed to a different replay id", () => {
		const events = makeReplayEvents();
		const seen: ReplayEvent[] = [];
		events.subscribe("r1", (e) => {
			seen.push(e);
		});
		events.emit("r2", { type: "completed", turns_written: 1, segments_written: 1 });
		expect(seen).toEqual([]);
	});

	it("unsubscribe removes the listener and cleans up empty sets", () => {
		const events = makeReplayEvents();
		let calls = 0;
		const off = events.subscribe("r1", () => {
			calls += 1;
		});
		expect(calls).toBe(0);
		expect(events.listenerCount("r1")).toBe(1);
		off();
		expect(events.listenerCount("r1")).toBe(0);
	});

	it("supports multiple listeners on one replay id", () => {
		const events = makeReplayEvents();
		const a: ReplayEvent[] = [];
		const b: ReplayEvent[] = [];
		events.subscribe("r1", (e) => a.push(e));
		events.subscribe("r1", (e) => b.push(e));
		events.emit("r1", { type: "progress", percent: 50, step: "vad" });
		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
	});
});
