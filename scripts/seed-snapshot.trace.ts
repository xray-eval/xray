/**
 * The trace the dev's agent would have emitted for a seeded replay, as OTLP.
 *
 * Kept out of `seed-snapshot.ts` because it's a separate concern from
 * synthesizing the audio and driving the analyze chain: this file turns a
 * scripted conversation into spans, and nothing here touches the store.
 *
 * The seeder pushes the result through the REAL receiver (`ingestOtlpTraces`),
 * so the vocabulary registry, the `tool_calls` / `model_usage` extraction, and
 * the read-time turn attribution all run exactly as they do in production —
 * same reason the analyze chain runs for real rather than having its rows
 * written by hand.
 *
 * Offsets are relative to the same variant-shifted script that produced the
 * WAV, and the recording origin is the replay's `startedAt`, so a span's
 * wall-clock maps to the intended audio offset without a clock read. Ids are
 * derived from the replay ordinal, so a regeneration stays byte-identical.
 */

import * as v from "valibot";

import type { ExportTraceServiceRequest } from "@/server/otlp/otlp.types.ts";
import { ExportTraceServiceRequestSchema } from "@/server/otlp/otlp.types.ts";

import type {
	ConversationKey,
	RunVariant,
	ScriptedConversation,
	ScriptedTurn,
} from "./seed-snapshot.types.ts";

export interface SeededSpan {
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	readonly startMs: number;
	readonly endMs: number;
	readonly attributes: Readonly<Record<string, string | number>>;
}

/**
 * The tool each agent turn calls, per conversation. Named per script so the
 * seeded trace reads as the agent that produced the transcript rather than as
 * generic filler. The seeder's `tool_called` assertions read their expected
 * name straight out of this record — which is the point: the trace is
 * load-bearing, so a regeneration that silently stopped persisting spans fails
 * the fixture's own assertions instead of quietly producing an empty span tree.
 */
export const TOOL_BY_CONVERSATION: Readonly<Record<ConversationKey, string>> = {
	"barge-in": "book_flight",
	lookup: "get_flight_status",
};

/** Tool arguments per agent turn index — the destination the turn commits to. */
const TOOL_ARGS_BY_TURN: Readonly<Record<ConversationKey, Readonly<Record<number, string>>>> = {
	"barge-in": { 1: "Paris", 3: "Berlin" },
	lookup: { 1: "LH1042" },
};

/** OTLP ids are fixed-width hex: 8 bytes for a span, 16 for a trace. */
const SPAN_ID_HEX_CHARS = 16;
const TRACE_ID_HEX_CHARS = 32;

/** `openai` / `google-gemini` from the variant's model id — no cast, no guessing. */
function providerFor(model: string): "openai" | "google-gemini" {
	if (model.startsWith("gpt")) return "openai";
	if (model.startsWith("gemini")) return "google-gemini";
	throw new Error(`seed-snapshot: no provider mapping for model "${model}"`);
}

function modelOf(variant: RunVariant): string {
	const { model } = variant.config;
	if (typeof model !== "string") {
		throw new Error(`seed-snapshot: run variant "${variant.key}" has no string model`);
	}
	return model;
}

/** Hex ids, derived so they're stable across regenerations. */
function seededSpanId(replayOrdinal: number, turnIdx: number, slot: number): string {
	const parts = [replayOrdinal, turnIdx, slot].map((n) => n.toString(16).padStart(2, "0"));
	return `5eed${parts.join("")}`.padEnd(SPAN_ID_HEX_CHARS, "0");
}

function seededTraceId(replayOrdinal: number): string {
	return `5eed7ace${replayOrdinal.toString(16).padStart(4, "0")}`.padEnd(TRACE_ID_HEX_CHARS, "0");
}

export function buildSeededTrace(
	conversation: ScriptedConversation,
	variant: RunVariant,
	script: readonly ScriptedTurn[],
	replayOrdinal: number,
): readonly SeededSpan[] {
	const model = modelOf(variant);
	const provider = providerFor(model);
	const toolName = TOOL_BY_CONVERSATION[conversation.key];
	const spans: SeededSpan[] = [];

	script.forEach((turn, turnIdx) => {
		const turnSpanId = seededSpanId(replayOrdinal, turnIdx, 0);
		spans.push({
			spanId: turnSpanId,
			name: "xray.turn",
			startMs: turn.startMs,
			endMs: turn.endMs,
			attributes: { "xray.turn.role": turn.role, "xray.turn.index": turnIdx },
		});
		if (turn.role !== "agent") return;

		// The model call straddles the start of the agent's speech: it begins in
		// the gap the agent was thinking in (the narrowest gap any variant
		// produces is 150ms, so -80 stays inside this turn's derived window) and
		// runs just past the first audio frame.
		const chatSpanId = seededSpanId(replayOrdinal, turnIdx, 1);
		spans.push({
			spanId: chatSpanId,
			parentSpanId: turnSpanId,
			name: "agent_turn",
			startMs: turn.startMs - 80,
			endMs: turn.startMs + 200,
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.system": provider,
				"gen_ai.request.model": model,
				"gen_ai.response.model": model,
				// Distinct per turn so the inspector's token bars aren't all identical.
				"gen_ai.usage.input_tokens": 480 + turnIdx * 122,
				"gen_ai.usage.output_tokens": 32 + turnIdx * 7,
				"gen_ai.response.time_to_first_chunk": 0.14 + turnIdx / 100,
			},
		});

		const destination = TOOL_ARGS_BY_TURN[conversation.key][turnIdx];
		if (destination === undefined) return;
		spans.push({
			spanId: seededSpanId(replayOrdinal, turnIdx, 2),
			parentSpanId: chatSpanId,
			name: "execute_tool",
			startMs: turn.startMs + 40,
			endMs: turn.startMs + 122,
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": toolName,
				// The same keys examples/livekit-voice-agent/agent/main.py sets.
				"gen_ai.tool.arguments": JSON.stringify({ destination, cabin: "economy" }),
				"gen_ai.tool.result": JSON.stringify({ confirmation: "QK4T2Z", destination }),
			},
		});

		// One Langfuse observation, so a fresh checkout shows the third recognized
		// vocabulary in the span tree and not just `xray.*` + GenAI semconv.
		if (turnIdx !== script.length - 1) return;
		spans.push({
			spanId: seededSpanId(replayOrdinal, turnIdx, 3),
			parentSpanId: chatSpanId,
			name: "booking_policy_check",
			startMs: turn.startMs + 260,
			endMs: turn.startMs + 282,
			attributes: {
				"langfuse.observation.type": "span",
				"langfuse.observation.name": "booking_policy_check",
				"langfuse.observation.metadata.rebook_window_min": "15",
			},
		});
	});

	return spans;
}

/**
 * Spans are ingested BEFORE the analyze chain, which is both faithful (the
 * agent emits them while the run is happening, long before anyone asks for
 * analysis) and a live check of the documented design: the receiver stores no
 * turn association, so it must not care that `replay_turns` is still empty.
 */
export function otlpRequestFor(
	replayId: string,
	replayOrdinal: number,
	startedAt: string,
	spans: readonly SeededSpan[],
): ExportTraceServiceRequest {
	const originMs = Date.parse(startedAt);
	const nanos = (offsetMs: number): string => String((originMs + offsetMs) * 1_000_000);
	const payload = {
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: "xray.replay.id", value: { stringValue: replayId } },
						{ key: "service.name", value: { stringValue: "snapshot-voice-agent" } },
					],
				},
				scopeSpans: [
					{
						scope: { name: "xray.sdk" },
						spans: spans.map((span) => ({
							traceId: seededTraceId(replayOrdinal),
							spanId: span.spanId,
							...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
							name: span.name,
							startTimeUnixNano: nanos(span.startMs),
							endTimeUnixNano: nanos(span.endMs),
							attributes: Object.entries(span.attributes).map(([key, value]) => ({
								key,
								value: typeof value === "string" ? { stringValue: value } : { doubleValue: value },
							})),
						})),
					},
				],
			},
		],
	};
	// Parsed with the receiver's own schema rather than hand-satisfying its
	// inferred type: if the wire contract changes, this fails here instead of
	// producing a fixture the real endpoint would have rejected.
	return v.parse(ExportTraceServiceRequestSchema, payload);
}
