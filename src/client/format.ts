export const HASH_PREFIX_LEN = 12;

export function shortHash(hash: string): string {
	return hash.slice(0, HASH_PREFIX_LEN);
}

/**
 * `Date#toLocaleString` uses the runtime's tz + locale, so the same string in
 * two browsers may render differently — intended for a self-hosted UI.
 */
export function formatAbsolute(iso: string): string {
	return new Date(iso).toLocaleString();
}

/**
 * Short timestamp with no year — use `formatAbsolute` when year
 * disambiguation matters. Formatter cached at module scope because
 * `Intl.DateTimeFormat` construction isn't cheap and this runs once per row
 * in trace-heavy views.
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
 * Render a playback offset (seconds) as `M:SS.d`. Deciseconds truncated via
 * `floor(sec * 10)`, not the naive `sec - floor(sec)` which underflows on
 * values like 5.3 (`5.3 - 5 === 0.2999…` → `.2`). Negative / non-finite
 * clamp to `0:00.0`.
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

export function formatTimelineTick(seconds: number): string {
	if (!Number.isFinite(seconds)) return "—";
	const sign = seconds < 0 ? "-" : "";
	const safe = Math.abs(seconds);
	if (safe < 10) return `${sign}${safe.toFixed(2)}s`;
	const totalTenths = Math.round(safe * 10);
	const totalWholeSec = Math.floor(totalTenths / 10);
	const tenth = totalTenths % 10;
	const minutes = Math.floor(totalWholeSec / 60);
	const secInMin = totalWholeSec - minutes * 60;
	return `${sign}${String(minutes).padStart(2, "0")}:${String(secInMin).padStart(2, "0")}.${tenth}`;
}

/**
 * `null` (no recorded duration yet) renders "in progress" — reads better than
 * an em-dash at the list/header sites that use this.
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
 * Distinct from `formatDuration`: trace latencies cluster in the sub-5-second
 * range where whole-second rounding erases the signal worth reading, and a
 * row with no resolved duration is missing data — so invalid/negative renders
 * an em-dash, not "in progress".
 */
export function formatDurationMs(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	// Round before the cutoff, else [999.5, 1000) rounds to "1000ms".
	const rounded = Math.round(ms);
	if (rounded < 1_000) return `${rounded}ms`;
	return `${(ms / 1_000).toFixed(2)}s`;
}
