/**
 * Extract the JSON object from an LLM's text reply. Providers without a
 * server-forced JSON mode (Bedrock Converse) are prompted to reply with
 * bare JSON, but a model still occasionally wraps it in a ```json fence or
 * adds a preamble ("Here is my verdict:") / trailer ("hope this helps").
 *
 * Slicing from the first `{` to the last `}` returns the outer object while
 * dropping any surrounding fence or prose — more robust than unwrapping a
 * fence, which only works when the fence spans the whole reply. Reasoning
 * models emit their thinking as a separate content block that upstream
 * parsing already drops, so a stray brace inside prose is not a concern
 * here. Returns the trimmed input unchanged when no object is present, so
 * the caller's `JSON.parse` surfaces the original text in its error.
 */
export function extractJsonObject(text: string): string {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	return start !== -1 && end > start ? text.slice(start, end + 1) : text.trim();
}
