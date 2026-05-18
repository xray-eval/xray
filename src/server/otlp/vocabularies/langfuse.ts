import type { FlatAttributes, ProjectedSpan } from "../otlp.types.ts";
import { asInteger, asString, msBetween, pickPrefixed, safeJsonString } from "./attrs.ts";
import type {
	ExtractedModelUsage,
	ExtractedToolCall,
	SpanVocabularyMatcher,
	VocabularyExtraction,
} from "./vocabularies.types.ts";

/**
 * Vocabulary: Langfuse trace format.
 * https://langfuse.com/docs/integrations/opentelemetry
 *
 * Langfuse spans carry attributes prefixed with `langfuse.observation.*` or
 * the legacy `langfuse.*`. Observations have a `type` field — we lift
 * `generation` to model_usage and `tool` to tool_calls. Other observation
 * types (`event`, `span`, `score`) become raw langfuse spans with no
 * extracted row.
 */
export const langfuseVocabulary: SpanVocabularyMatcher = (
	span: ProjectedSpan,
): VocabularyExtraction | null => {
	const a = span.attributes;
	if (!hasLangfuseAttribute(a)) return null;

	const narrowed: FlatAttributes = pickPrefixed(a, "langfuse.");
	const out: VocabularyExtraction = { vocabulary: "langfuse", attributes: narrowed };

	const startedAt = span.startedAt;
	const endedAt = span.endedAt;
	const latencyMs = msBetween(startedAt, endedAt);
	const type = asString(a["langfuse.observation.type"]) ?? asString(a["langfuse.type"]);

	if (type === "generation") {
		const usage: ExtractedModelUsage = {
			provider: asString(a["langfuse.observation.provider"]),
			model: asString(a["langfuse.observation.model.name"]),
			inputTokens: asInteger(a["langfuse.observation.usage_details.input"]),
			outputTokens: asInteger(a["langfuse.observation.usage_details.output"]),
			totalTokens: asInteger(a["langfuse.observation.usage_details.total"]),
			startedAt,
			endedAt,
			latencyMs,
		};
		out.modelUsage = [usage];
		return out;
	}

	if (type === "tool") {
		const name = asString(a["langfuse.observation.name"]) ?? span.name;
		if (name.length > 0) {
			const args = asString(a["langfuse.observation.input.value"]);
			const result = asString(a["langfuse.observation.output.value"]);
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

	return out;
};

function hasLangfuseAttribute(a: FlatAttributes): boolean {
	for (const k of Object.keys(a)) if (k.startsWith("langfuse.")) return true;
	return false;
}
