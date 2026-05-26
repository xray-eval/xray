import type { ReactNode, RefObject } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { PlayerProviderMissingError } from "./player-provider.errors.ts";

export type PlayerControls = Readonly<{
	seek: (seconds: number) => void;
	highlight: (rangeStartSec: number, rangeEndSec: number) => void;
	clearHighlight: () => void;
}>;

export type PlayerHandle = Readonly<{
	isReady: boolean;
	seek: (seconds: number) => void;
	highlight: (rangeStartSec: number, rangeEndSec: number) => void;
	clearHighlight: () => void;
}>;

type PlayerContextValue = Readonly<{
	isReady: boolean;
	setReady: (ready: boolean) => void;
	registerControls: (controls: PlayerControls | null) => void;
	controlsRef: RefObject<PlayerControls | null>;
}>;

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
	const [isReady, setReady] = useState(false);
	const controlsRef = useRef<PlayerControls | null>(null);

	const registerControls = useCallback((controls: PlayerControls | null) => {
		controlsRef.current = controls;
	}, []);

	const value = useMemo<PlayerContextValue>(
		() => ({ isReady, setReady, registerControls, controlsRef }),
		[isReady, registerControls],
	);

	return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerHandle {
	const ctx = useContext(PlayerContext);
	if (ctx === null) throw new PlayerProviderMissingError();
	const { isReady, controlsRef } = ctx;

	const seek = useCallback(
		(seconds: number) => {
			controlsRef.current?.seek(seconds);
		},
		[controlsRef],
	);

	const highlight = useCallback(
		(rangeStartSec: number, rangeEndSec: number) => {
			controlsRef.current?.highlight(rangeStartSec, rangeEndSec);
		},
		[controlsRef],
	);

	const clearHighlight = useCallback(() => {
		controlsRef.current?.clearHighlight();
	}, [controlsRef]);

	return useMemo(
		() => ({ isReady, seek, highlight, clearHighlight }),
		[isReady, seek, highlight, clearHighlight],
	);
}

/**
 * Called by the audio player to publish its imperative handle to the
 * provider. Pass `null` controls when the underlying player isn't ready
 * yet — consumers' `seek` / `highlight` become safe no-ops.
 *
 * Tolerates being called outside a provider: the player is allowed to mount
 * standalone (no coordinating UI). Only `usePlayer` (the consumer side)
 * treats the missing provider as a programming error.
 */
export function useRegisterPlayer(controls: PlayerControls | null): void {
	const ctx = useContext(PlayerContext);
	const registerControls = ctx?.registerControls;
	const setReady = ctx?.setReady;

	useEffect(() => {
		if (!registerControls || !setReady) return;
		registerControls(controls);
		setReady(controls !== null);
		return () => {
			registerControls(null);
			setReady(false);
		};
	}, [controls, registerControls, setReady]);
}
