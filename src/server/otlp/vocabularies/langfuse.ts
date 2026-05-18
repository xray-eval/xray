import type { FlatAttributes, ProjectedSpan } from "../otlp.types.ts";
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
export const langfuseVocabulary: SpanVocabularyMatcher = {
	id: "langfuse",
	match(span: ProjectedSpan): VocabularyExtraction | null {
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
	},
};

function hasLangfuseAttribute(a: FlatAttributes): boolean {
	for (const k of Object.keys(a)) if (k.startsWith("langfuse.")) return true;
	return false;
}

function pickPrefixed(attrs: FlatAttributes, prefix: string): FlatAttributes {
	const out: FlatAttributes = {};
	for (const [k, v] of Object.entries(attrs)) {
		if (k.startsWith(prefix)) out[k] = v;
	}
	return out;
}

function asString(v: FlatAttributes[string] | undefined): string | null {
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return null;
}

function asInteger(v: FlatAttributes[string] | undefined): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
	if (typeof v === "string" && /^[-+]?\d+$/.test(v)) return Number(v);
	return null;
}

function safeJsonString(maybeJson: string): string {
	try {
		const parsed = JSON.parse(maybeJson);
		return JSON.stringify(parsed);
	} catch {
		return JSON.stringify(maybeJson);
	}
}

function msBetween(startedAt: string, endedAt: string): number | null {
	const start = Date.parse(startedAt);
	const end = Date.parse(endedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	const ms = end - start;
	return ms >= 0 ? ms : null;
}
