import { projectRequest } from "@/server/otlp/otlp.service.ts";
import { SPAN_VOCABULARIES } from "@/server/otlp/vocabularies/registry.ts";

import { buildSeededTrace, otlpRequestFor, TOOL_BY_CONVERSATION } from "./seed-snapshot.trace.ts";
import type { RunVariant, ScriptedConversation, ScriptedTurn } from "./seed-snapshot.types.ts";
import { describe, expect, it } from "bun:test";

const SCRIPT: readonly ScriptedTurn[] = [
	{ role: "user", startMs: 0, endMs: 1800, amplitude: 6_000, transcript: "Book me a flight." },
	{ role: "agent", startMs: 2300, endMs: 4600, amplitude: 9_000, transcript: "Booking it." },
	{ role: "user", startMs: 4300, endMs: 5500, amplitude: 12_000, transcript: "No, wait." },
	{ role: "agent", startMs: 6000, endMs: 8000, amplitude: 15_000, transcript: "Got it." },
];

const CONVERSATION: ScriptedConversation = {
	key: "barge-in",
	name: "user corrects destination mid-answer",
	script: SCRIPT,
	specTurns: [],
	recordingEndMs: 8200,
};

const VARIANT: RunVariant = {
	key: "baseline",
	configName: "baseline",
	config: { model: "gpt-4o" },
	agentDelayMs: 0,
};

describe("buildSeededTrace", () => {
	// OTLP ids are fixed-width hex — 8 bytes for a span, 16 for a trace. A short
	// id is accepted by the receiver (nothing validates the width) but no real
	// exporter can produce one, so the fixture would ship ids that undercut the
	// whole point of pushing it through the real receiver.
	it("emits 16-hex-char span ids and a 32-hex-char trace id", () => {
		const spans = buildSeededTrace(CONVERSATION, VARIANT, SCRIPT, 1);
		expect(spans.length).toBeGreaterThan(0);
		for (const span of spans) {
			expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
		}
		const [projected] = projectRequest(
			otlpRequestFor("replay-1", 1, "2026-07-01T12:00:00.000Z", spans),
		);
		expect(projected?.span.traceId).toMatch(/^[0-9a-f]{32}$/);
	});

	it("gives every span in a replay a distinct id, and every replay its own trace", () => {
		const ordinals = [1, 2, 3, 4, 5, 6, 7];
		const allSpanIds = ordinals.flatMap((o) =>
			buildSeededTrace(CONVERSATION, VARIANT, SCRIPT, o).map((s) => s.spanId),
		);
		expect(new Set(allSpanIds).size).toBe(allSpanIds.length);

		const traceIds = ordinals.map((o) => {
			const spans = buildSeededTrace(CONVERSATION, VARIANT, SCRIPT, o);
			return projectRequest(otlpRequestFor("r", o, "2026-07-01T12:00:00.000Z", spans))[0]?.span
				.traceId;
		});
		expect(new Set(traceIds).size).toBe(ordinals.length);
	});

	// Each agent turn contributes a turn span, a model call and a tool call; the
	// last one also carries the Langfuse observation. A user turn contributes
	// only its turn span.
	it("emits one span per role, with the Langfuse observation only on the last agent turn", () => {
		const spans = buildSeededTrace(CONVERSATION, VARIANT, SCRIPT, 1);
		expect(spans.map((s) => s.name)).toEqual([
			"xray.turn",
			"xray.turn",
			"agent_turn",
			"execute_tool",
			"xray.turn",
			"xray.turn",
			"agent_turn",
			"execute_tool",
			"booking_policy_check",
		]);
		const tools = spans.filter((s) => s.name === "execute_tool");
		for (const tool of tools) {
			expect(tool.attributes["gen_ai.tool.name"]).toBe(TOOL_BY_CONVERSATION["barge-in"]);
		}
	});

	// Vocabulary identity comes from the attributes, not the span name, so this
	// runs the built spans through the registry the receiver itself uses — the
	// fixture's promise is that a fresh clone shows all three.
	it("is recognized as all three vocabularies by the real registry", () => {
		const spans = buildSeededTrace(CONVERSATION, VARIANT, SCRIPT, 1);
		const projected = projectRequest(otlpRequestFor("r", 1, "2026-07-01T12:00:00.000Z", spans));
		const claimed = projected.map((p) => {
			for (const matcher of SPAN_VOCABULARIES) {
				const extraction = matcher(p.span, p.resource);
				if (extraction !== null) return extraction.vocabulary;
			}
			return "unrecognized";
		});
		expect(new Set(claimed)).toEqual(new Set(["xray", "gen_ai", "langfuse"]));
		expect(claimed).not.toContain("unrecognized");
	});

	// Pins the offset the turn-attribution argument in `seed-snapshot.trace.ts`
	// depends on.
	it("starts the model call 80ms before the agent's first frame", () => {
		const spans = buildSeededTrace(CONVERSATION, VARIANT, SCRIPT, 1);
		const chats = spans.filter((s) => s.name === "agent_turn");
		expect(chats.map((s) => s.startMs)).toEqual([2220, 5920]);
	});

	it("refuses a run variant whose model has no provider mapping", () => {
		const unknown: RunVariant = { ...VARIANT, config: { model: "llama-3" } };
		expect(() => buildSeededTrace(CONVERSATION, unknown, SCRIPT, 1)).toThrow(/no provider mapping/);
	});

	it("refuses a run variant with no string model", () => {
		const unconfigured: RunVariant = { ...VARIANT, config: { temperature: 0.2 } };
		expect(() => buildSeededTrace(CONVERSATION, unconfigured, SCRIPT, 1)).toThrow(
			/no string model/,
		);
	});
});

describe("otlpRequestFor", () => {
	// The receiver reads nanos through BigInt, so the string the seeder writes
	// has to be the exact integer — `originMs * 1e6` is past Number.MAX_SAFE_INTEGER.
	it("writes span timestamps the receiver reads back to the intended ms", () => {
		const startedAt = "2026-07-01T12:00:00.000Z";
		const origin = Date.parse(startedAt);
		const spans = buildSeededTrace(CONVERSATION, VARIANT, SCRIPT, 1);
		const projected = projectRequest(otlpRequestFor("replay-1", 1, startedAt, spans));
		expect(projected).toHaveLength(spans.length);
		projected.forEach((p, i) => {
			const span = spans[i];
			if (span === undefined) throw new Error("missing span");
			expect(Date.parse(p.span.startedAt) - origin).toBe(span.startMs);
			expect(Date.parse(p.span.endedAt) - origin).toBe(span.endMs);
		});
	});

	it("routes every span to the replay via the resource attribute", () => {
		const spans = buildSeededTrace(CONVERSATION, VARIANT, SCRIPT, 1);
		const projected = projectRequest(
			otlpRequestFor("replay-7", 7, "2026-07-01T12:00:00.000Z", spans),
		);
		for (const p of projected) {
			expect(p.resource["xray.replay.id"]).toBe("replay-7");
		}
	});
});
