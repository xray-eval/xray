/**
 * Combine an external AbortSignal (e.g. one shared across sibling
 * `Promise.all` provider calls) with an internal per-request timeout.
 * When either fires, the merged signal aborts — so a failing sibling
 * cancels the in-flight siblings instead of letting them keep burning
 * the provider's quota. With no external signal it is just the timeout.
 *
 * Shared by every HTTP provider (transcription + TTS); kept here next to
 * `fetch.ts` / `redact.ts` so a fix lands in one place, not six.
 */
export function mergeAbortSignals(
	external: AbortSignal | undefined,
	timeoutMs: number,
): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (external === undefined) return timeoutSignal;
	return AbortSignal.any([external, timeoutSignal]);
}
