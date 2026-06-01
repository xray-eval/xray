import { useEffect } from "react";

import { usePublishPlayhead } from "./player-provider.tsx";

export interface WavesurferPlayheadSource {
	getCurrentTime(): number;
	isPlaying(): boolean;
	on(event: "timeupdate" | "play" | "pause", listener: () => void): () => void;
}

export function usePublishWavesurferPlayhead(source: WavesurferPlayheadSource | null): void {
	const publishPlayhead = usePublishPlayhead();
	useEffect(() => {
		if (!source) return;
		const update = () =>
			publishPlayhead({ sec: source.getCurrentTime(), playing: source.isPlaying() });
		const offs = [
			source.on("timeupdate", update),
			source.on("play", update),
			source.on("pause", update),
		];
		return () => {
			for (const off of offs) off();
		};
	}, [source, publishPlayhead]);
}
