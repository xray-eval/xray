import { match } from "ts-pattern";

import type { Assertion, AssertionContext, AssertionOutcome } from "./assertions.types.ts";

const NO_TRANSCRIPT_MESSAGE = "no transcript available for this turn";
const NO_ANCHOR_MESSAGE =
	"no recording anchor — cannot attribute spans to turns (upload omitted X-Recording-Started-At)";

/**
 * Assertion kinds whose verdict depends on span→turn attribution, which needs
 * the recording anchor. Classified once here rather than guarded ad hoc in each
 * arm: without the anchor these all map to `errored` (not a misleading
 * pass/fail), and a new timeline-dependent kind inherits that behaviour by
 * being added to this set — the omission is visible in one place instead of
 * hiding behind a forgotten per-arm guard.
 */
const TIMELINE_DEPENDENT_KINDS: ReadonlySet<Assertion["kind"]> = new Set([
	"tool_called",
	"tool_not_called",
	"tool_args_match",
	"max_ttft_ms",
]);

const passed: AssertionOutcome = { status: "passed", message: null };
function failed(message: string): AssertionOutcome {
	return { status: "failed", message };
}
function errored(message: string): AssertionOutcome {
	return { status: "errored", message };
}

/**
 * Run one assertion against one turn's context. Pure function: every byte
 * needed for the verdict is on `ctx`. Returns the outcome — never throws
 * on a per-assertion failure (those are outcomes). Throws only if the
 * variant dispatch itself is broken, which ts-pattern's `.exhaustive()`
 * prevents at compile time.
 *
 * Null transcript → every text-based variant maps to `errored` with a
 * stable message rather than asserting against an empty string. That way
 * the inspector can render a useful failure reason instead of a
 * misleading "no match" verdict that's actually a transcription failure.
 */
export function evaluateAssertion(assertion: Assertion, ctx: AssertionContext): AssertionOutcome {
	if (!ctx.hasRecordingAnchor && TIMELINE_DEPENDENT_KINDS.has(assertion.kind)) {
		return errored(NO_ANCHOR_MESSAGE);
	}
	return match(assertion)
		.with({ kind: "contains" }, (a) => {
			if (ctx.transcript === null) return errored(NO_TRANSCRIPT_MESSAGE);
			const haystack = a.case_insensitive ? ctx.transcript.toLowerCase() : ctx.transcript;
			const needle = a.case_insensitive ? a.text.toLowerCase() : a.text;
			return haystack.includes(needle) ? passed : failed(`transcript did not contain "${a.text}"`);
		})
		.with({ kind: "not_contains" }, (a) => {
			if (ctx.transcript === null) return errored(NO_TRANSCRIPT_MESSAGE);
			const haystack = a.case_insensitive ? ctx.transcript.toLowerCase() : ctx.transcript;
			const needle = a.case_insensitive ? a.text.toLowerCase() : a.text;
			return haystack.includes(needle)
				? failed(`transcript contained forbidden text "${a.text}"`)
				: passed;
		})
		.with({ kind: "equals" }, (a) => {
			if (ctx.transcript === null) return errored(NO_TRANSCRIPT_MESSAGE);
			let actual = ctx.transcript;
			let expected = a.text;
			if (a.trim) {
				actual = actual.trim();
				expected = expected.trim();
			}
			if (a.case_insensitive) {
				actual = actual.toLowerCase();
				expected = expected.toLowerCase();
			}
			return actual === expected ? passed : failed(`transcript "${actual}" != "${expected}"`);
		})
		.with({ kind: "regex" }, (a) => {
			if (ctx.transcript === null) return errored(NO_TRANSCRIPT_MESSAGE);
			let re: RegExp;
			try {
				re = new RegExp(a.pattern, a.flags);
			} catch (cause) {
				const detail = cause instanceof Error ? cause.message : String(cause);
				return errored(`invalid regex /${a.pattern}/${a.flags}: ${detail}`);
			}
			return re.test(ctx.transcript)
				? passed
				: failed(`transcript did not match /${a.pattern}/${a.flags}`);
		})
		.with({ kind: "tool_called" }, (a) => {
			const hit = ctx.toolCalls.some((tc) => tc.name === a.name);
			return hit ? passed : failed(`tool "${a.name}" was not called in this turn`);
		})
		.with({ kind: "tool_not_called" }, (a) => {
			const hit = ctx.toolCalls.some((tc) => tc.name === a.name);
			return hit ? failed(`tool "${a.name}" was called but should not have been`) : passed;
		})
		.with({ kind: "tool_args_match" }, (a) => {
			const candidates = ctx.toolCalls.filter((tc) => tc.name === a.name);
			if (candidates.length === 0) {
				return failed(`tool "${a.name}" was not called in this turn`);
			}
			for (const tc of candidates) {
				if (tc.argsJson === null) continue;
				let recorded: unknown;
				try {
					recorded = JSON.parse(tc.argsJson);
				} catch {
					continue;
				}
				if (deepPartialMatch(a.args, recorded)) return passed;
			}
			return failed(`no call to "${a.name}" matched the expected args ${JSON.stringify(a.args)}`);
		})
		.with({ kind: "max_latency_ms" }, (a) => {
			if (ctx.metrics.agentResponseMs === null) {
				return errored("no agent_response_ms metric — likely a user turn or pre-first-agent turn");
			}
			return ctx.metrics.agentResponseMs <= a.max_ms
				? passed
				: failed(`agent_response_ms ${ctx.metrics.agentResponseMs}ms > max ${a.max_ms}ms`);
		})
		.with({ kind: "max_ttft_ms" }, (a) => {
			if (ctx.metrics.ttftMs === null) {
				// Distinguish the two failure modes so the dev knows whether the
				// problem is "no LLM call landed in this turn" (mistiming /
				// attribution) vs "the calls that did land don't emit TTFT"
				// (instrumentation gap) — they need different fixes.
				return errored(
					ctx.modelUsage.length === 0
						? "no ttft_ms — no model call landed in this turn's window"
						: "no ttft_ms — no in-window model call carried gen_ai.response.time_to_first_chunk",
				);
			}
			return ctx.metrics.ttftMs <= a.max_ms
				? passed
				: failed(`ttft_ms ${ctx.metrics.ttftMs}ms > max ${a.max_ms}ms`);
		})
		.exhaustive();
}

/**
 * Deep-partial match: every key/value in `expected` must be present in
 * `actual` with a matching value. Extra keys in `actual` are fine. Arrays
 * match positionally; primitive values match strictly via `Object.is`.
 *
 * Why not `lodash.isMatch`: pulling lodash for a 30-line helper would be
 * pure cost. The match semantics here are intentionally narrow — array
 * extra-element tolerance / regex matching / etc. can be added if a real
 * test needs them.
 */
export function deepPartialMatch(expected: unknown, actual: unknown): boolean {
	if (expected === null || typeof expected !== "object") {
		return Object.is(expected, actual);
	}
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual)) return false;
		if (expected.length !== actual.length) return false;
		for (let i = 0; i < expected.length; i++) {
			if (!deepPartialMatch(expected[i], actual[i])) return false;
		}
		return true;
	}
	if (!isPlainObject(actual)) return false;
	for (const [k, v] of Object.entries(expected)) {
		if (!Object.hasOwn(actual, k)) return false;
		if (!deepPartialMatch(v, actual[k])) return false;
	}
	return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
