/**
 * Strip API key prefixes from any string we're about to embed in an
 * error message or log line. Provider 4xx responses commonly echo a
 * truncated key prefix into the error body — without this helper, every
 * "wrong key" error sprays partial credential material into the
 * operator's stdout / log aggregator (Datadog, Loki, etc.).
 *
 * Patterns covered:
 *   - OpenAI: `sk-...` (project keys `sk-proj-...` + classic)
 *   - Google: `AIza...` (39+ chars, the common Google API key prefix)
 */
export function redactProviderSecrets(text: string): string {
	return text.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***").replace(/AIza[A-Za-z0-9_-]{35,}/g, "AIza***");
}
