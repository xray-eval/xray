import { mergeAbortSignals } from "./abort.ts";
import { describe, expect, it } from "bun:test";

describe("mergeAbortSignals", () => {
	it("returns a fresh, un-aborted signal when no external signal is given", () => {
		const signal = mergeAbortSignals(undefined, 60_000);
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal.aborted).toBe(false);
	});

	it("is already aborted when the external signal is already aborted", () => {
		const controller = new AbortController();
		controller.abort(new Error("caller bailed"));
		const signal = mergeAbortSignals(controller.signal, 60_000);
		expect(signal.aborted).toBe(true);
	});

	it("propagates a later external abort", () => {
		const controller = new AbortController();
		const signal = mergeAbortSignals(controller.signal, 60_000);
		expect(signal.aborted).toBe(false);
		controller.abort();
		expect(signal.aborted).toBe(true);
	});

	it("aborts on its own once the timeout elapses", async () => {
		const signal = mergeAbortSignals(undefined, 1);
		expect(signal.aborted).toBe(false);
		await Bun.sleep(20);
		expect(signal.aborted).toBe(true);
	});
});
