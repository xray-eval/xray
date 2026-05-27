import * as v from "valibot";

// Gemini `generateContent` response envelope, validated at the provider
// boundary. We read only `candidates[0].content.parts[].text` (joined) and
// an optional `promptFeedback.blockReason` so a safety block surfaces as a
// distinct error instead of "empty candidates". Shared by both Gemini
// providers (transcription + judge) — they hit the same upstream API, so
// the envelope handling lives here, not duplicated per slice.
const GeminiPartSchema = v.object({
	text: v.optional(v.string()),
});
const GeminiContentSchema = v.object({
	parts: v.optional(v.array(GeminiPartSchema)),
});
const GeminiCandidateSchema = v.object({
	content: v.optional(GeminiContentSchema),
	finishReason: v.optional(v.string()),
});
export const GeminiResponseSchema = v.object({
	candidates: v.optional(v.array(GeminiCandidateSchema)),
	promptFeedback: v.optional(
		v.object({
			blockReason: v.optional(v.string()),
		}),
	),
});

/**
 * Extract the joined candidate text from a Gemini `generateContent`
 * response, or throw via `makeError` on any envelope problem: schema
 * validation failure, a `promptFeedback.blockReason` safety block, an empty
 * candidates array, a non-`STOP` `finishReason` (e.g. `MAX_TOKENS`,
 * `RECITATION`, `SAFETY`), or empty content.
 *
 * `makeError` is an error-factory so each caller throws its own slice error
 * (`JudgeProviderError` / `TranscriptionProviderError`) while the envelope
 * logic stays in one place — the only thing that differed between the two
 * providers' copies was the error class.
 */
export function extractGeminiText(raw: unknown, makeError: (message: string) => Error): string {
	const result = v.safeParse(GeminiResponseSchema, raw);
	if (!result.success) {
		throw makeError(
			`response failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	const parsed = result.output;
	const blockReason = parsed.promptFeedback?.blockReason;
	if (blockReason !== undefined) {
		throw makeError(`prompt blocked by safety filter: ${blockReason}`);
	}
	const first = parsed.candidates?.[0];
	if (first === undefined) {
		throw makeError("response candidates array was empty");
	}
	if (first.finishReason !== undefined && first.finishReason !== "STOP") {
		throw makeError(`candidate finished with reason "${first.finishReason}" (expected STOP)`);
	}
	const parts = first.content?.parts ?? [];
	const text = parts.map((p) => p.text ?? "").join("");
	if (text.length === 0) {
		throw makeError("candidate content was empty");
	}
	return text;
}
