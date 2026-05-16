import type { BaseIssue } from "valibot";

import { sanitizeIssues } from "./sanitize-issues.ts";
import { describe, expect, it } from "bun:test";

describe("sanitizeIssues", () => {
	it("strips `input` and `value` at the issue level", () => {
		const issues: BaseIssue<unknown>[] = [
			{
				kind: "schema",
				type: "string",
				expected: "string",
				received: "number",
				message: "Invalid type",
				input: "x".repeat(10_000),
			},
		];
		const out = sanitizeIssues(issues);
		expect(out[0]).toEqual({
			kind: "schema",
			type: "string",
			expected: "string",
			received: "number",
			message: "Invalid type",
			path: undefined,
		});
		expect(JSON.stringify(out)).not.toContain("xxx");
	});

	it("strips `input`/`value` from each path step", () => {
		const issues: BaseIssue<unknown>[] = [
			{
				kind: "schema",
				type: "string",
				expected: "string",
				received: "number",
				message: "Invalid type",
				input: undefined,
				path: [
					{
						type: "object",
						origin: "value",
						input: { secret: "leaked" },
						key: "text",
						value: 42,
					},
				],
			},
		];
		const out = sanitizeIssues(issues);
		expect(out[0]?.path).toEqual([{ type: "object", origin: "value", key: "text" }]);
		expect(JSON.stringify(out)).not.toContain("leaked");
	});
});
