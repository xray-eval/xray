import { deepPartialMatch, evaluateAssertion } from "./assertions.evaluator.ts";
import { makeAssertionContext, makeToolCallRow } from "./assertions.test-utils.ts";
import { describe, expect, it } from "bun:test";

describe("evaluateAssertion — contains", () => {
	it("passes when the transcript contains the text (case-insensitive by default)", () => {
		const ctx = makeAssertionContext({ transcript: "Sure, I'll book that table for two." });
		const outcome = evaluateAssertion(
			{ kind: "contains", text: "BOOK THAT", case_insensitive: true },
			ctx,
		);
		expect(outcome.status).toBe("passed");
	});

	it("respects case-sensitive mode", () => {
		const ctx = makeAssertionContext({ transcript: "Sure, I'll book that table." });
		const outcome = evaluateAssertion(
			{ kind: "contains", text: "BOOK", case_insensitive: false },
			ctx,
		);
		expect(outcome.status).toBe("failed");
	});

	it("returns errored when transcript is null", () => {
		const ctx = makeAssertionContext({ transcript: null });
		const outcome = evaluateAssertion(
			{ kind: "contains", text: "anything", case_insensitive: true },
			ctx,
		);
		expect(outcome.status).toBe("errored");
		expect(outcome.message).toMatch(/no transcript/);
	});
});

describe("evaluateAssertion — not_contains", () => {
	it("passes when the forbidden text is absent", () => {
		const ctx = makeAssertionContext({ transcript: "everything is fine" });
		const outcome = evaluateAssertion(
			{ kind: "not_contains", text: "error", case_insensitive: true },
			ctx,
		);
		expect(outcome.status).toBe("passed");
	});

	it("fails when forbidden text is present", () => {
		const ctx = makeAssertionContext({ transcript: "an error occurred" });
		const outcome = evaluateAssertion(
			{ kind: "not_contains", text: "ERROR", case_insensitive: true },
			ctx,
		);
		expect(outcome.status).toBe("failed");
	});

	it("returns errored when transcript is null", () => {
		const ctx = makeAssertionContext({ transcript: null });
		const outcome = evaluateAssertion(
			{ kind: "not_contains", text: "x", case_insensitive: true },
			ctx,
		);
		expect(outcome.status).toBe("errored");
	});
});

describe("evaluateAssertion — equals", () => {
	it("passes on exact (trimmed, case-insensitive) match", () => {
		const ctx = makeAssertionContext({ transcript: "  Hello WORLD  " });
		const outcome = evaluateAssertion(
			{ kind: "equals", text: "hello world", case_insensitive: true, trim: true },
			ctx,
		);
		expect(outcome.status).toBe("passed");
	});

	it("fails on near-match when trim is off", () => {
		const ctx = makeAssertionContext({ transcript: "  hello world  " });
		const outcome = evaluateAssertion(
			{ kind: "equals", text: "hello world", case_insensitive: true, trim: false },
			ctx,
		);
		expect(outcome.status).toBe("failed");
	});

	it("returns errored when transcript is null", () => {
		const ctx = makeAssertionContext({ transcript: null });
		const outcome = evaluateAssertion(
			{ kind: "equals", text: "x", case_insensitive: true, trim: true },
			ctx,
		);
		expect(outcome.status).toBe("errored");
	});
});

describe("evaluateAssertion — regex", () => {
	it("passes when the pattern matches", () => {
		const ctx = makeAssertionContext({ transcript: "Order #1234 confirmed." });
		const outcome = evaluateAssertion({ kind: "regex", pattern: "Order #\\d+", flags: "" }, ctx);
		expect(outcome.status).toBe("passed");
	});

	it("respects flags (case-insensitive)", () => {
		const ctx = makeAssertionContext({ transcript: "ORDER" });
		const outcome = evaluateAssertion({ kind: "regex", pattern: "order", flags: "i" }, ctx);
		expect(outcome.status).toBe("passed");
	});

	it("returns errored when the pattern is invalid", () => {
		const ctx = makeAssertionContext({ transcript: "x" });
		const outcome = evaluateAssertion({ kind: "regex", pattern: "[unclosed", flags: "" }, ctx);
		expect(outcome.status).toBe("errored");
		expect(outcome.message).toMatch(/invalid regex/);
	});

	it("returns errored when transcript is null", () => {
		const ctx = makeAssertionContext({ transcript: null });
		const outcome = evaluateAssertion({ kind: "regex", pattern: ".", flags: "" }, ctx);
		expect(outcome.status).toBe("errored");
	});
});

describe("evaluateAssertion — tool_called / tool_not_called", () => {
	it("tool_called passes when the named tool was invoked", () => {
		const ctx = makeAssertionContext({
			toolCalls: [makeToolCallRow({ name: "reserve_table" })],
		});
		const outcome = evaluateAssertion({ kind: "tool_called", name: "reserve_table" }, ctx);
		expect(outcome.status).toBe("passed");
	});

	it("tool_called fails when the tool wasn't called", () => {
		const ctx = makeAssertionContext({ toolCalls: [makeToolCallRow({ name: "search" })] });
		const outcome = evaluateAssertion({ kind: "tool_called", name: "reserve_table" }, ctx);
		expect(outcome.status).toBe("failed");
	});

	it("tool_not_called passes when the tool wasn't called", () => {
		const ctx = makeAssertionContext({ toolCalls: [] });
		const outcome = evaluateAssertion({ kind: "tool_not_called", name: "delete_user" }, ctx);
		expect(outcome.status).toBe("passed");
	});

	it("tool_not_called fails when the tool was called", () => {
		const ctx = makeAssertionContext({
			toolCalls: [makeToolCallRow({ name: "delete_user" })],
		});
		const outcome = evaluateAssertion({ kind: "tool_not_called", name: "delete_user" }, ctx);
		expect(outcome.status).toBe("failed");
	});
});

describe("evaluateAssertion — tool_args_match", () => {
	it("passes when the recorded args deep-partially match the expected sub-object", () => {
		const ctx = makeAssertionContext({
			toolCalls: [
				makeToolCallRow({
					name: "reserve_table",
					argsJson: JSON.stringify({ party_size: 2, time: "19:00", note: "window seat" }),
				}),
			],
		});
		const outcome = evaluateAssertion(
			{ kind: "tool_args_match", name: "reserve_table", args: { party_size: 2 } },
			ctx,
		);
		expect(outcome.status).toBe("passed");
	});

	it("fails when no call matched the expected args", () => {
		const ctx = makeAssertionContext({
			toolCalls: [
				makeToolCallRow({
					name: "reserve_table",
					argsJson: JSON.stringify({ party_size: 4 }),
				}),
			],
		});
		const outcome = evaluateAssertion(
			{ kind: "tool_args_match", name: "reserve_table", args: { party_size: 2 } },
			ctx,
		);
		expect(outcome.status).toBe("failed");
	});

	it("fails when the tool wasn't called at all", () => {
		const ctx = makeAssertionContext({ toolCalls: [] });
		const outcome = evaluateAssertion({ kind: "tool_args_match", name: "missing", args: {} }, ctx);
		expect(outcome.status).toBe("failed");
	});

	it("skips a candidate with invalid JSON args, keeps looking", () => {
		const ctx = makeAssertionContext({
			toolCalls: [
				makeToolCallRow({ name: "x", argsJson: "not json" }),
				makeToolCallRow({ name: "x", argsJson: JSON.stringify({ a: 1 }) }),
			],
		});
		const outcome = evaluateAssertion({ kind: "tool_args_match", name: "x", args: { a: 1 } }, ctx);
		expect(outcome.status).toBe("passed");
	});
});

describe("evaluateAssertion — max_latency_ms", () => {
	it("passes when agentResponseMs is within budget", () => {
		const ctx = makeAssertionContext({ agentResponseMs: 1500 });
		const outcome = evaluateAssertion({ kind: "max_latency_ms", max_ms: 2000 }, ctx);
		expect(outcome.status).toBe("passed");
	});

	it("fails when agentResponseMs exceeds budget", () => {
		const ctx = makeAssertionContext({ agentResponseMs: 3000 });
		const outcome = evaluateAssertion({ kind: "max_latency_ms", max_ms: 2000 }, ctx);
		expect(outcome.status).toBe("failed");
	});

	it("returns errored when no metric available", () => {
		const ctx = makeAssertionContext({ agentResponseMs: null });
		const outcome = evaluateAssertion({ kind: "max_latency_ms", max_ms: 2000 }, ctx);
		expect(outcome.status).toBe("errored");
	});
});

describe("evaluateAssertion — max_ttft_ms", () => {
	it("passes when ttftMs is within budget", () => {
		const ctx = makeAssertionContext({ ttftMs: 400 });
		const outcome = evaluateAssertion({ kind: "max_ttft_ms", max_ms: 500 }, ctx);
		expect(outcome.status).toBe("passed");
	});

	it("fails when ttftMs exceeds budget", () => {
		const ctx = makeAssertionContext({ ttftMs: 800 });
		const outcome = evaluateAssertion({ kind: "max_ttft_ms", max_ms: 500 }, ctx);
		expect(outcome.status).toBe("failed");
	});

	it("returns errored when no TTFT span was attributed to this turn", () => {
		const ctx = makeAssertionContext({ ttftMs: null });
		const outcome = evaluateAssertion({ kind: "max_ttft_ms", max_ms: 500 }, ctx);
		expect(outcome.status).toBe("errored");
	});
});

describe("deepPartialMatch", () => {
	it("matches nested objects partially", () => {
		expect(deepPartialMatch({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2, d: 3 }, e: 99 })).toBe(true);
	});

	it("requires exact array length", () => {
		expect(deepPartialMatch([1, 2], [1, 2, 3])).toBe(false);
		expect(deepPartialMatch([1, 2], [1, 2])).toBe(true);
	});

	it("matches primitives via Object.is", () => {
		expect(deepPartialMatch(0, -0)).toBe(false);
		expect(deepPartialMatch(Number.NaN, Number.NaN)).toBe(true);
		expect(deepPartialMatch("x", "x")).toBe(true);
	});

	it("returns false when expected has a key actual lacks", () => {
		expect(deepPartialMatch({ a: 1 }, { b: 2 })).toBe(false);
	});
});
