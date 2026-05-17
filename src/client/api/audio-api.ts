/**
 * Build the absolute URL the browser's `<audio>` element should fetch for a
 * given turn. The path mirrors the server route in
 * `src/server/audio/audio.router.ts` — keep these two in sync.
 */
export function turnAudioUrl(sessionId: string, turnIdx: number): string {
	return new URL(
		`/v1/sessions/${encodeURIComponent(sessionId)}/turns/${turnIdx}/audio`,
		window.location.origin,
	).toString();
}
