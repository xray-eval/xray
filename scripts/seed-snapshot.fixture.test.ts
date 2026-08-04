import {
	ALL_SCRIPTED_TURNS,
	CONVERSATIONS,
	DECLARED_ASSERTIONS_BY_CONVERSATION,
	requireConversation,
	requireVariant,
	SEED_REPLAYS,
} from "./seed-snapshot.fixture.ts";
import { expectedExtractions, TOOL_BY_CONVERSATION } from "./seed-snapshot.trace.ts";
import { describe, expect, it } from "bun:test";

describe("the fixture catalog", () => {
	// The stand-in transcription provider recovers a turn's line by matching the
	// peak amplitude of its audio slice. Two turns sharing an amplitude — in the
	// same script or across scripts — would silently swap transcripts, and the
	// `contains` assertions would still pass on the wrong text.
	it("gives every scripted turn an amplitude no other turn uses", () => {
		const amplitudes = ALL_SCRIPTED_TURNS.map((t) => t.amplitude);
		expect(new Set(amplitudes).size).toBe(amplitudes.length);
	});

	it("keeps every turn's window forward-going", () => {
		for (const turn of ALL_SCRIPTED_TURNS) {
			expect(turn.endMs).toBeGreaterThan(turn.startMs);
		}
	});

	it("records enough recording length to hold every turn", () => {
		for (const conversation of CONVERSATIONS) {
			const lastEnd = Math.max(...conversation.script.map((t) => t.endMs));
			expect(conversation.recordingEndMs).toBeGreaterThanOrEqual(lastEnd);
		}
	});

	// The spec is what the server evaluates; the script is what the audio says.
	// A spec with a different number of turns would evaluate assertions against
	// the wrong turn index.
	it("declares one spec turn per scripted turn, in the same roles", () => {
		for (const conversation of CONVERSATIONS) {
			expect(conversation.specTurns.map((t) => t.role)).toEqual(
				conversation.script.map((t) => t.role),
			);
		}
	});

	// Which turns emit a tool call is fixture CONTENT — it lives in the trace
	// builder's per-turn argument table, so the seeder's runtime guard derives its
	// expectation from the same place and a deleted entry moves both together.
	// Only the turn a `tool_called` assertion sits on is caught at runtime, so the
	// counts are pinned here instead: dropping the Paris booking is then a failing
	// test rather than two barge-in replays quietly losing half their story.
	it("emits a model call per agent turn and a tool call on the committing turns", () => {
		const bargeIn = requireConversation("barge-in");
		expect(expectedExtractions(bargeIn, bargeIn.script)).toEqual({ modelUsage: 2, toolCalls: 2 });
		const lookup = requireConversation("lookup");
		expect(expectedExtractions(lookup, lookup.script)).toEqual({ modelUsage: 1, toolCalls: 1 });
	});

	it("asserts on the same tool name the seeded trace emits", () => {
		for (const conversation of CONVERSATIONS) {
			const toolAssertions = conversation.specTurns
				.flatMap((turn) => turn.assertions)
				.filter((a) => a.kind === "tool_called");
			expect(toolAssertions.length).toBeGreaterThan(0);
			for (const assertion of toolAssertions) {
				expect(assertion.name).toBe(TOOL_BY_CONVERSATION[conversation.key]);
			}
		}
	});

	// Initialized at module load from `CONVERSATIONS` via a hoisted call, so a
	// refactor that turned either helper into a `const` arrow would throw at
	// import time. This test is what notices.
	it("derives the declared assertion count from the specs", () => {
		expect(DECLARED_ASSERTIONS_BY_CONVERSATION).toEqual({ "barge-in": 3, lookup: 2 });
		for (const conversation of CONVERSATIONS) {
			const declared = conversation.specTurns.reduce((n, t) => n + t.assertions.length, 0);
			expect(DECLARED_ASSERTIONS_BY_CONVERSATION[conversation.key]).toBe(declared);
		}
	});
});

describe("the seeded replays", () => {
	it("gives every replay a distinct id and a resolvable variant + conversation", () => {
		const ids = SEED_REPLAYS.map((s) => s.replayId);
		expect(new Set(ids).size).toBe(ids.length);
		for (const seed of SEED_REPLAYS) {
			expect(requireVariant(seed.variantKey).key).toBe(seed.variantKey);
			expect(requireConversation(seed.conversationKey).key).toBe(seed.conversationKey);
		}
	});

	// The compare view's fair-comparison warning only renders when coverage is
	// partial, so the fixture has to contain a conversation that not every config
	// ran. Losing that makes the warning unreachable on a fresh clone.
	it("leaves run-config coverage deliberately partial", () => {
		const configsPerConversation = new Map<string, Set<string>>();
		for (const seed of SEED_REPLAYS) {
			const configs = configsPerConversation.get(seed.conversationKey) ?? new Set<string>();
			configs.add(seed.variantKey);
			configsPerConversation.set(seed.conversationKey, configs);
		}
		const counts = [...configsPerConversation.values()].map((c) => c.size);
		expect(new Set(counts).size).toBeGreaterThan(1);
	});

	it("resolves every replay's start time to a real instant", () => {
		for (const seed of SEED_REPLAYS) {
			expect(Number.isFinite(Date.parse(seed.startedAt))).toBe(true);
		}
	});
});

describe("requireVariant", () => {
	// `variantKey` is a plain string (the variants aren't a closed union the way
	// the conversation keys are), so a typo in `SEED_REPLAYS` is reachable and has
	// to fail loudly rather than seed a replay with no config.
	it("throws on an unknown run variant", () => {
		expect(() => requireVariant("no-such-variant")).toThrow(/unknown run variant/);
	});
});
