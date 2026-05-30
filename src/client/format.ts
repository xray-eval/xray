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
 * Render a playback offset (in seconds) as a `M:SS.d` clock, e.g. `0:05.3` /
 * `1:23.7`. Deciseconds are truncated via `floor(sec * 10)` rather than the
 * naive `sec - floor(sec)` subtraction, which underflows on values like 5.3
 * (`5.3 - 5 === 0.2999…` → would show `.2`). Negative / non-finite inputs
 * clamp to `0:00.0`. Shared by the audio clock readout and the trace-tree
 * playhead pill so they always agree.
 */
export function formatClockSeconds(seconds: number): string {
	const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
	const totalTenths = Math.floor(safe * 10);
	const minutes = Math.floor(totalTenths / 600);
	const withinMinute = totalTenths - minutes * 600;
	const wholeSeconds = Math.floor(withinMinute / 10);
	const tenths = withinMinute % 10;
	return `${minutes}:${String(wholeSeconds).padStart(2, "0")}.${tenths}`;
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

/**
 * Render a span/turn duration in ms for trace views: `123ms` below a second,
 * `1.23s` at or above it. Two reasons it's distinct from `formatDuration`:
 * trace latencies cluster in the sub-5-second range where whole-second
 * rounding erases the signal worth reading, and a row with no resolved
 * duration is missing data — so invalid/negative input renders an em-dash,
 * not "in progress".
 */
export function formatDurationMs(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	return `${(ms / 1_000).toFixed(2)}s`;
}
