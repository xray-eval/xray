import { memo, useMemo } from "react";

import { usePlayer, usePlayhead } from "@/client/audio/player-provider.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card.tsx";
import { cn } from "@/client/lib/utils.ts";

import type { ReplayDetailResponse, TurnRole } from "../../api/api.types.ts";
import type { TranscriptEntry } from "./transcript-model.ts";
import {
	activeTurnIndex,
	activeWordIndexForEntry,
	buildTranscriptView,
} from "./transcript-model.ts";

export function TranscriptCard({ replay }: { replay: ReplayDetailResponse }) {
	// Memoized so each entry keeps a stable reference across playhead ticks —
	// that's what lets the memoized rows skip re-rendering 60×/s (only the
	// active row, which receives a changing `currentMs`, re-renders).
	const entries = useMemo(
		() => buildTranscriptView(replay.transcripts, replay.turns),
		[replay.transcripts, replay.turns],
	);
	if (entries.length === 0) return null;
	const provider = replay.transcripts[0]?.provider;
	return (
		<Card className="gap-0 overflow-hidden p-0">
			<CardHeader className="gap-0 border-b-[1px] border-border/60 px-5 py-4">
				<div className="flex items-baseline justify-between gap-3">
					<CardTitle className="text-base font-semibold tracking-tight text-foreground">
						Transcript
					</CardTitle>
					<span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70">
						{entries.length} {entries.length === 1 ? "turn" : "turns"}
						{provider !== undefined ? ` · ${provider}` : ""}
					</span>
				</div>
			</CardHeader>
			<CardContent className="scroll-panel max-h-[26rem] divide-y divide-border/40 overflow-y-auto p-0">
				<TranscriptBody entries={entries} />
			</CardContent>
		</Card>
	);
}

function TranscriptBody({ entries }: { entries: TranscriptEntry[] }) {
	const { sec } = usePlayhead();
	const player = usePlayer();
	const activeIdx = activeTurnIndex(entries, sec);
	return (
		<ol>
			{entries.map((entry, i) => (
				<TranscriptRow
					key={entry.turnIdx}
					entry={entry}
					isActive={i === activeIdx}
					currentMs={i === activeIdx ? sec * 1000 : null}
					onSeek={player.seek}
					onHighlight={player.highlight}
				/>
			))}
		</ol>
	);
}

const TranscriptRow = memo(function TranscriptRowItem({
	entry,
	isActive,
	currentMs,
	onSeek,
	onHighlight,
}: {
	entry: TranscriptEntry;
	isActive: boolean;
	currentMs: number | null;
	onSeek: (sec: number) => void;
	onHighlight: (startSec: number, endSec: number) => void;
}) {
	const handleClick = () => {
		onSeek(entry.voiceStartMs / 1000);
		onHighlight(entry.voiceStartMs / 1000, entry.voiceEndMs / 1000);
	};
	return (
		<li>
			<button
				type="button"
				onClick={handleClick}
				aria-current={isActive ? "true" : undefined}
				className={cn(
					"flex w-full gap-3 px-5 py-3 text-left transition-colors",
					isActive ? "bg-muted/40" : "hover:bg-muted/20",
				)}
			>
				<RoleTag role={entry.role} active={isActive} />
				<p
					className={cn(
						"min-w-0 flex-1 text-sm leading-relaxed",
						isActive ? "text-foreground" : "text-foreground/80",
					)}
				>
					<TranscriptText entry={entry} currentMs={currentMs} />
				</p>
			</button>
		</li>
	);
});

function RoleTag({ role, active }: { role: TurnRole; active: boolean }) {
	const isUser = role === "user";
	return (
		<span
			className={cn(
				"mt-0.5 inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em]",
				isUser ? "text-sky-400" : "text-orange-400",
			)}
		>
			<span
				className={cn(
					"size-1.5 rounded-full",
					isUser ? "bg-sky-400" : "bg-orange-400",
					active && (isUser ? "ring-2 ring-sky-400/30" : "ring-2 ring-orange-400/30"),
				)}
			/>
			{isUser ? "User" : "Agent"}
		</span>
	);
}

function TranscriptText({
	entry,
	currentMs,
}: {
	entry: TranscriptEntry;
	currentMs: number | null;
}) {
	if (entry.words === null || currentMs === null) return <>{entry.text}</>;
	const active = activeWordIndexForEntry(entry, currentMs);
	// Key by each word's running character offset — not start/end ms (which
	// collide when two words round to the same window) and not the array index
	// (lint/suspicious/noArrayIndexKey). The offset strictly increases, so it's
	// unique even for repeated tokens at identical timings.
	let charOffset = 0;
	return (
		<>
			{entry.words.map((word, i) => {
				const key = `${charOffset}:${word.text}`;
				charOffset += word.text.length + 1;
				return (
					<span
						key={key}
						className={cn(i === active && "rounded-[3px] bg-foreground/15 text-foreground")}
					>
						{word.text}{" "}
					</span>
				);
			})}
		</>
	);
}
