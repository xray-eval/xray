import type { ConversationTurn } from "@/server/sessions/sessions.types.ts";

import { turnAudioUrl } from "../api/audio-api.ts";

export interface TurnAudioProps {
	sessionId: string;
	turn: Pick<ConversationTurn, "idx" | "role" | "text">;
	/** Optional extra classes — defaults to the inspector's compact layout. */
	className?: string;
}

/**
 * Plays a turn's recorded audio. `preload="none"` keeps bytes off the wire
 * until the user clicks play — otherwise a long transcript would fire one
 * HEAD per element on mount. The src points at the audio HTTP endpoint;
 * actual bytes flow lazily. The inline <track> carries the turn's transcript
 * as a single-cue caption so the a11y `useMediaCaption` rule passes without a
 * suppression (per .claude/rules/no-lint-suppressions.md).
 */
export function TurnAudio({ sessionId, turn, className }: TurnAudioProps) {
	return (
		<audio
			controls
			preload="none"
			src={turnAudioUrl(sessionId, turn.idx)}
			aria-label={`Audio for ${turn.role} turn ${turn.idx}`}
			className={className ?? "mt-2 w-full max-w-sm"}
		>
			<track kind="captions" srcLang="en" label="Transcript" src={transcriptVttUrl(turn.text)} />
		</audio>
	);
}

/**
 * Build a `data:text/vtt;...` URL containing the turn transcript as a single
 * caption cue spanning a long-enough window to cover any audio length. Lets
 * us satisfy `useMediaCaption` without serving captions from disk — the text
 * is already in the model.
 */
function transcriptVttUrl(text: string): string {
	const sanitized = text.replace(/-->/g, "→").trim() || "(no transcript)";
	const vtt = `WEBVTT\n\n00:00:00.000 --> 99:59:59.999\n${sanitized}\n`;
	return `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`;
}
