interface AudioWithCaptionsProps {
	src: string;
	captionText: string | null;
	className?: string;
	label?: string;
}

/**
 * The captions track satisfies the `useMediaCaption` a11y rule (and the
 * no-lint-suppressions rule that forbids ignoring it). With no transcript we
 * still emit a tiny placeholder cue so the track element is valid VTT.
 */
export function AudioWithCaptions({ src, captionText, className, label }: AudioWithCaptionsProps) {
	const captionsUrl = toCaptionsDataUrl(captionText);
	return (
		<audio controls className={className} preload="none" aria-label={label}>
			<source src={src} />
			<track default kind="captions" src={captionsUrl} srcLang="en" label="English" />
		</audio>
	);
}

/**
 * Encodes a single 30-min cue (`00:00:00.000 --> 00:30:00.000`) — long enough
 * to stay shown for the full audio in v1, where we have no word-level timing.
 */
export function toCaptionsDataUrl(captionText: string | null): string {
	const trimmed = (captionText ?? "").trim() || "(no transcript)";
	const vtt = `WEBVTT\n\n00:00:00.000 --> 00:30:00.000\n${trimmed.replace(/\r?\n/g, " ")}`;
	return `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`;
}
