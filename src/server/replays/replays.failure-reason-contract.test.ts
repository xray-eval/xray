import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { REPLAY_FAILURE_REASONS } from "@/server/store/types.ts";

import { describe, expect, it } from "bun:test";

/**
 * Contract test — the SDK's `xray.errors.FailureReason` literal must be a
 * subset of the server's `REPLAY_FAILURE_REASONS` picklist. The two enums
 * meet on the wire: every PATCH `/v1/replays/:id` with `failure_reason: X`
 * gets validated against `v.picklist(REPLAY_FAILURE_REASONS)`. A drift on
 * either side rejects every failure-path PATCH with a 400.
 *
 * This test parses the Python source directly so a future SDK contributor
 * who adds a value to `FailureReason` without updating the server picklist
 * gets a red CI run instead of a silent runtime 400.
 */
describe("FailureReason cross-language contract", () => {
	it("every SDK FailureReason literal is a member of the server picklist", () => {
		const path = resolve(import.meta.dir, "../../../sdk/python/src/xray/errors.py");
		const source = readFileSync(path, "utf8");

		// Pull the `FailureReason = Literal[ ... ]` block. Tolerates any
		// whitespace + ordering, but the alias must be defined exactly once.
		const match = source.match(/FailureReason\s*=\s*Literal\[([^\]]+)\]/);
		expect(match).not.toBeNull();
		if (match === null) throw new Error("FailureReason literal not found");

		const sdkValues: string[] = [];
		const inner = match[1] ?? "";
		for (const m of inner.matchAll(/"([a-z_]+)"/g)) {
			const v = m[1];
			if (v !== undefined) sdkValues.push(v);
		}
		expect(sdkValues.length).toBeGreaterThan(0);

		const serverSet = new Set<string>(REPLAY_FAILURE_REASONS);
		for (const value of sdkValues) {
			expect(serverSet.has(value)).toBe(true);
		}
	});
});
