/**
 * Unwrap a markdown code fence from an LLM's text reply. Providers without
 * a server-forced JSON mode (Bedrock Converse) are prompted to reply with
 * bare JSON, but models still occasionally wrap it in ```json fences —
 * strip the wrapper before `JSON.parse` instead of failing the replay.
 * Only a fence spanning the whole (trimmed) reply is unwrapped; inner
 * backticks and unterminated fences pass through untouched.
 */
export function stripCodeFences(text: string): string {
	const trimmed = text.trim();
	const match = /^```[A-Za-z0-9_-]*[ \t]*\n?([\s\S]*?)\n?```$/.exec(trimmed);
	const inner = match?.[1];
	return inner !== undefined ? inner.trim() : trimmed;
}
