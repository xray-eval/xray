/**
 * Render an ISO 8601 timestamp in the user's locale. `Date#toLocaleString`
 * uses the runtime's tz + locale, so the same string in two browsers may
 * render differently — that's the intended behavior for a self-hosted UI.
 */
export function formatAbsolute(iso: string): string {
	return new Date(iso).toLocaleString();
}

/** Alias used by the Conversation/Replay views — same as `formatAbsolute`. */
export const formatTimestamp = formatAbsolute;

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
