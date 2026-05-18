import type { FlatAttributes, ProjectedSpan } from "../otlp.types.ts";
import { asInteger, asString, msBetween, pickPrefixed, safeJsonString } from "./attrs.ts";
import type {
	ExtractedModelUsage,
	ExtractedToolCall,
	SpanVocabularyMatcher,
	VocabularyExtraction,
} from "./vocabularies.types.ts";

/**
 * Vocabulary: OpenTelemetry GenAI semantic conventions.
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *
 * Recognized span names (subset matching v1's needs):
 * - `chat <model>` / `text_completion <model>` — LLM call. Extract model_usage.
 *   Attributes: gen_ai.operation.name, gen_ai.system, gen_ai.request.model,
 *   gen_ai.response.model, gen_ai.usage.input_tokens, gen_ai.usage.output_tokens.
 * - `execute_tool <tool>` — tool call. Extract tool_calls.
 *   Attributes: gen_ai.operation.name='execute_tool', gen_ai.tool.name,
 *   gen_ai.tool.arguments?, gen_ai.tool.result?
 *
 * A span whose `gen_ai.operation.name` is set but isn't `chat`,
 * `text_completion`, or `execute_tool` is persisted as a raw `gen_ai` span
 * with no extracted row — useful for the span tree in the inspector.
 */
export const genAiSemconvVocabulary: SpanVocabularyMatcher = (
	span: ProjectedSpan,
): VocabularyExtraction | null => {
	const a = span.attributes;
	const op = asString(a["gen_ai.operation.name"]);
	const looksLikeGenAi =
		op !== null || hasGenAiAttribute(a) || /^(chat|text_completion|execute_tool)/.test(span.name);
	if (!looksLikeGenAi) return null;

	const narrowed: FlatAttributes = pickPrefixed(a, "gen_ai.");
	const out: VocabularyExtraction = { vocabulary: "gen_ai", attributes: narrowed };

	const startedAt = span.startedAt;
	const endedAt = span.endedAt;
	const latencyMs = msBetween(startedAt, endedAt);

	if (op === "execute_tool" || /^execute_tool\b/.test(span.name)) {
		const name = asString(a["gen_ai.tool.name"]) ?? span.name.replace(/^execute_tool\s*/, "");
		if (name.length > 0) {
			const args = asString(a["gen_ai.tool.arguments"]);
			const result = asString(a["gen_ai.tool.result"]);
			const tc: ExtractedToolCall = {
				name,
				argsJson: args === null ? null : safeJsonString(args),
				resultJson: result === null ? null : safeJsonString(result),
				startedAt,
				endedAt,
				latencyMs,
			};
			out.toolCalls = [tc];
		}
		return out;
	}

	if (op === "chat" || op === "text_completion" || /^(chat|text_completion)\b/.test(span.name)) {
		const usage: ExtractedModelUsage = {
			provider: asString(a["gen_ai.system"]),
			model: asString(a["gen_ai.response.model"]) ?? asString(a["gen_ai.request.model"]),
			inputTokens: asInteger(a["gen_ai.usage.input_tokens"]),
			outputTokens: asInteger(a["gen_ai.usage.output_tokens"]),
			totalTokens: addOrNull(
				asInteger(a["gen_ai.usage.input_tokens"]),
				asInteger(a["gen_ai.usage.output_tokens"]),
			),
			startedAt,
			endedAt,
			latencyMs,
		};
		out.modelUsage = [usage];
		return out;
	}

	return out;
};

function hasGenAiAttribute(a: FlatAttributes): boolean {
	for (const k of Object.keys(a)) if (k.startsWith("gen_ai.")) return true;
	return false;
}

function addOrNull(a: number | null, b: number | null): number | null {
	if (a === null && b === null) return null;
	return (a ?? 0) + (b ?? 0);
}
