export const HASH_PREFIX_LEN = 12;

/** Truncate a 64-char SHA-256 hex to a UI-friendly prefix. Display only. */
export function shortHash(hash: string): string {
	return hash.slice(0, HASH_PREFIX_LEN);
}

/**
 * Render an ISO 8601 timestamp in the user's locale. `Date#toLocaleString`
 * uses the runtime's tz + locale, so the same string in two browsers may
 * render differently — that's the intended behavior for a self-hosted UI.
 */
export function formatAbsolute(iso: string): string {
	return new Date(iso).toLocaleString();
}

/**
 * Locale-aware short timestamp with no year. Every UI site pairs this with
 * a "Started"/"Finished"/range label, so the recent-relative reading is
 * what matters. Use `formatAbsolute` when year disambiguation matters.
 *
 * Cached at module scope because `Intl.DateTimeFormat` construction is
 * not cheap and we call this once per row in trace-heavy views.
 */
const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
});

export function formatTimestamp(iso: string): string {
	return TIMESTAMP_FORMATTER.format(new Date(iso));
}

/**
 * Render a duration in ms as `123ms` / `42s` / `2m05s`. `null` means the
 * session/turn has no recorded duration yet — "in progress" reads better
 * than an em-dash or empty cell at the list/header sites that use this.
 */
export function formatDuration(ms: number | null): string {
	if (ms === null) return "in progress";
	if (ms < 1000) return `${ms}ms`;
	const secs = Math.round(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const m = Math.floor(secs / 60);
	const s = secs % 60;
	return `${m}m${s.toString().padStart(2, "0")}s`;
}
