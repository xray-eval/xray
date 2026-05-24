import { useWavesurfer } from "@wavesurfer/react";
import { PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";

import type { ReplayTurnResponse } from "@/client/api/api.types.ts";
import { Badge } from "@/client/components/ui/badge.tsx";
import { Button } from "@/client/components/ui/button.tsx";
import { cn } from "@/client/lib/utils.ts";

/**
 * Hex / rgba color literals live INSIDE the wavesurfer config only — they
 * have to be CSS color strings the canvas renderer can consume, and Tailwind
 * tokens (oklch CSS variables) don't resolve through JS. The complementary
 * legend swatches in JSX use `bg-sky-400` / `bg-orange-400` — the same
 * sky-400 / orange-400 we feed to the wavesurfer canvas below.
 */
const USER_WAVE = "#38bdf8"; // sky-400
const AGENT_WAVE = "#fb923c"; // orange-400
const USER_REGION_FILL = "rgba(56, 189, 248, 0.16)";
const AGENT_REGION_FILL = "rgba(251, 146, 60, 0.18)";
const CURSOR_COLOR = "#ffffff";

interface StereoTurnPlayerProps {
	audioUrl: string;
	turns: readonly ReplayTurnResponse[];
	className?: string;
}

/**
 * Stereo WAV player with per-turn region overlays. Left channel = user (sky),
 * right channel = agent (orange). Regions are read-only — clicking one seeks
 * to its start and plays. The component owns its wavesurfer instance for the
 * lifetime of the mount; the regions plugin instance is co-lived with it.
 */
export function StereoTurnPlayer({ audioUrl, turns, className }: StereoTurnPlayerProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);

	// useState's lazy init gives us exactly one RegionsPlugin per component
	// instance — `useMemo` is not a stability guarantee.
	const [regions] = useState(() => RegionsPlugin.create());
	const plugins = useMemo(() => [regions], [regions]);

	// Each wavesurfer option that's a non-primitive must be referentially
	// stable, otherwise @wavesurfer/react tears down and recreates the
	// instance on every render (the hook deps-array spreads option values).
	// progressColor === waveColor → the bars keep their channel tone whether
	// played or not. The "played" cue is the translucent white overlay
	// rendered as a sibling div below, not a color swap.
	const splitChannels = useMemo(
		() => [
			{ waveColor: USER_WAVE, progressColor: USER_WAVE },
			{ waveColor: AGENT_WAVE, progressColor: AGENT_WAVE },
		],
		[],
	);

	const { wavesurfer, isPlaying, isReady, currentTime } = useWavesurfer({
		container: containerRef,
		url: audioUrl,
		height: 56,
		waveColor: USER_WAVE,
		progressColor: USER_WAVE,
		cursorColor: CURSOR_COLOR,
		cursorWidth: 2,
		barWidth: 2,
		barGap: 1,
		barRadius: 2,
		normalize: true,
		splitChannels,
		plugins,
	});

	const { duration, loadError } = useWaveState(wavesurfer);

	// Refresh regions when audio loads or the turns prop changes. clearRegions
	// is a no-op pre-load, so guarding on isReady avoids drawing regions onto
	// a zero-duration canvas (they'd render at width 0).
	useEffect(() => {
		if (!isReady) return;
		regions.clearRegions();
		for (const turn of turns) {
			regions.addRegion({
				id: `turn-${turn.idx}-${turn.role}`,
				start: turn.turn_start_ms / 1000,
				end: turn.turn_end_ms / 1000,
				color: turn.role === "user" ? USER_REGION_FILL : AGENT_REGION_FILL,
				drag: false,
				resize: false,
				channelIdx: turn.role === "user" ? 0 : 1,
			});
		}
	}, [isReady, regions, turns]);

	useEffect(() => {
		const unsubscribe = regions.on("region-clicked", (region, event) => {
			event.stopPropagation();
			region.play();
		});
		return unsubscribe;
	}, [regions]);

	return (
		<div
			className={cn(
				"group relative overflow-hidden rounded-xl border border-border/70 bg-card/60 shadow-sm backdrop-blur-sm transition-colors",
				className,
			)}
		>
			<div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-sky-400/70 via-transparent to-orange-400/70" />

			<div className="flex items-center justify-between gap-4 px-5 pt-4 pb-3">
				<div className="flex items-center gap-2">
					<Badge variant="outline" className="gap-1.5 lowercase tracking-wide">
						<span
							aria-hidden="true"
							className="size-2 rounded-full bg-sky-400 ring-2 ring-sky-400/30"
						/>
						user
					</Badge>
					<Badge variant="outline" className="gap-1.5 lowercase tracking-wide">
						<span
							aria-hidden="true"
							className="size-2 rounded-full bg-orange-400 ring-2 ring-orange-400/30"
						/>
						agent
					</Badge>
				</div>
				<span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
					Stereo · {turns.length} {turns.length === 1 ? "turn" : "turns"}
				</span>
			</div>

			<section className="px-2 pb-1" aria-label="Replay waveform">
				<div className="relative">
					<div ref={containerRef} className="w-full" />
					<div
						aria-hidden="true"
						className="pointer-events-none absolute inset-y-0 left-0 bg-white/15"
						style={{ width: `${Math.min(playedFraction(currentTime, duration) * 100, 100)}%` }}
					/>
					{loadError !== null && (
						<p
							role="alert"
							className="absolute inset-0 flex items-center justify-center bg-card/80 text-xs text-destructive backdrop-blur-sm"
						>
							Couldn't load audio. {loadError}
						</p>
					)}
				</div>
			</section>

			<div className="flex items-center gap-4 border-t border-border/50 bg-muted/30 px-5 py-3">
				<Button
					type="button"
					size="icon-sm"
					variant="default"
					onClick={() => wavesurfer?.playPause()}
					disabled={!isReady}
					aria-label={isPlaying ? "Pause" : "Play"}
					className="rounded-full"
				>
					{isPlaying ? <PauseIcon /> : <PlayIcon />}
				</Button>
				<div className="font-mono text-xs tabular-nums text-foreground/90">
					<span className="text-foreground">{formatClock(currentTime)}</span>
					<span className="text-muted-foreground"> / {formatClock(duration)}</span>
				</div>
			</div>
		</div>
	);
}

/**
 * Track the two pieces of wavesurfer state the hook doesn't expose:
 *   - `duration` — `getDuration()` only returns non-zero after "ready", so
 *      we sync via the "ready" event.
 *   - `loadError` — when the fetch / decode fails, "ready" never fires and
 *     `isReady` stays false forever; without this we'd render a permanently
 *     disabled player with no feedback. The "error" payload from wavesurfer
 *     is `unknown` (Event | Error | string); we surface the human-readable
 *     part and let CSS overlay the error message on the empty canvas.
 */
function useWaveState(wavesurfer: WaveSurfer | null): {
	duration: number;
	loadError: string | null;
} {
	const [duration, setDuration] = useState(0);
	const [loadError, setLoadError] = useState<string | null>(null);
	useEffect(() => {
		if (!wavesurfer) {
			setDuration(0);
			setLoadError(null);
			return;
		}
		setDuration(wavesurfer.getDuration());
		setLoadError(null);
		const offReady = wavesurfer.on("ready", () => {
			setDuration(wavesurfer.getDuration());
			setLoadError(null);
		});
		const offError = wavesurfer.on("error", (err: unknown) => {
			setLoadError(err instanceof Error ? err.message : String(err));
		});
		return () => {
			offReady();
			offError();
		};
	}, [wavesurfer]);
	return { duration, loadError };
}

function playedFraction(currentTime: number, duration: number): number {
	if (!(duration > 0) || !Number.isFinite(currentTime)) return 0;
	return Math.max(0, currentTime / duration);
}

function formatClock(seconds: number): string {
	const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
	const minutes = Math.floor(safe / 60);
	const rest = safe - minutes * 60;
	const wholeSeconds = Math.floor(rest);
	const tenths = Math.floor((rest - wholeSeconds) * 10);
	return `${minutes}:${String(wholeSeconds).padStart(2, "0")}.${tenths}`;
}
