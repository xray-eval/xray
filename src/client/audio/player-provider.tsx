import type { ReactNode, RefObject } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import { PlayerProviderMissingError } from "./player-provider.errors.ts";

export type PlayerControls = Readonly<{
	seek: (seconds: number) => void;
	highlight: (rangeStartSec: number, rangeEndSec: number) => void;
	clearHighlight: () => void;
}>;

/** Current audio playback position, published by the player ~60fps. */
export type PlayheadState = Readonly<{ sec: number; playing: boolean }>;

const INITIAL_PLAYHEAD: PlayheadState = { sec: 0, playing: false };

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
	// Playhead is a high-frequency signal routed through a ref + listener set —
	// same imperative-handle shape as `controlsRef` — so publishing a new
	// position never re-renders the provider or its row consumers, only the
	// single leaf that subscribes via `usePlayhead`.
	playheadRef: RefObject<PlayheadState>;
	setPlayhead: (state: PlayheadState) => void;
	subscribePlayhead: (listener: () => void) => () => void;
}>;

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
	const [isReady, setReady] = useState(false);
	const controlsRef = useRef<PlayerControls | null>(null);

	const registerControls = useCallback((controls: PlayerControls | null) => {
		controlsRef.current = controls;
	}, []);

	const playheadRef = useRef<PlayheadState>(INITIAL_PLAYHEAD);
	const playheadListeners = useRef<Set<() => void>>(new Set());
	const setPlayhead = useCallback((state: PlayheadState) => {
		playheadRef.current = state;
		for (const listener of playheadListeners.current) listener();
	}, []);
	const subscribePlayhead = useCallback((listener: () => void) => {
		playheadListeners.current.add(listener);
		return () => {
			playheadListeners.current.delete(listener);
		};
	}, []);

	const value = useMemo<PlayerContextValue>(
		() => ({
			isReady,
			setReady,
			registerControls,
			controlsRef,
			playheadRef,
			setPlayhead,
			subscribePlayhead,
		}),
		[isReady, registerControls, setPlayhead, subscribePlayhead],
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

export function usePlayhead(): PlayheadState {
	const ctx = useContext(PlayerContext);
	if (ctx === null) throw new PlayerProviderMissingError();
	const { playheadRef, subscribePlayhead } = ctx;
	return useSyncExternalStore(subscribePlayhead, () => playheadRef.current);
}

/**
 * Returns a stable function the audio player calls to publish the current
 * playhead position. Tolerates being called outside a provider (no-op) so the
 * player can mount standalone — mirrors `useRegisterPlayer`.
 */
export function usePublishPlayhead(): (state: PlayheadState) => void {
	const ctx = useContext(PlayerContext);
	const setPlayhead = ctx?.setPlayhead;
	return useCallback(
		(state: PlayheadState) => {
			setPlayhead?.(state);
		},
		[setPlayhead],
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
