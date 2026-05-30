import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type SpanSelection = Readonly<{
	selectedSpanId: string | null;
	select: (spanId: string) => void;
	clear: () => void;
}>;

const INERT_SELECTION: SpanSelection = {
	selectedSpanId: null,
	select: () => undefined,
	clear: () => undefined,
};

const SpanSelectionContext = createContext<SpanSelection | null>(null);

/**
 * Holds the id of the span the user is inspecting. Wraps the trace tree and
 * the detail panel so a click in the tree drives the panel without threading
 * `selectedSpanId` through the tree's internal depth — the same context shape
 * the player provider uses to coordinate across the inspector's two columns.
 */
export function SpanSelectionProvider({ children }: { children: ReactNode }) {
	const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
	const select = useCallback((spanId: string) => setSelectedSpanId(spanId), []);
	const clear = useCallback(() => setSelectedSpanId(null), []);
	const value = useMemo<SpanSelection>(
		() => ({ selectedSpanId, select, clear }),
		[selectedSpanId, select, clear],
	);
	return <SpanSelectionContext.Provider value={value}>{children}</SpanSelectionContext.Provider>;
}

/**
 * Read + drive the selected span. Tolerates being called outside a
 * `<SpanSelectionProvider>`: the trace tree is allowed to mount standalone
 * (tests, isolation), where selection is simply inert — `select`/`clear`
 * no-op and `selectedSpanId` stays null. Mirrors the player provider's
 * producer-side tolerance (`useRegisterPlayer` / `usePublishPlayhead`).
 */
export function useSpanSelection(): SpanSelection {
	return useContext(SpanSelectionContext) ?? INERT_SELECTION;
}
