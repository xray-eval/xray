import { ChevronDownIcon, ChevronRightIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { match } from "ts-pattern";

import type { ReplayTurnResponse, SpanResponse } from "@/client/api/api.types.ts";
import { usePlayer, usePlayhead } from "@/client/audio/player-provider.tsx";
import { formatClockSeconds, formatDurationMs } from "@/client/format.ts";
import { cn } from "@/client/lib/utils.ts";

import { buildTree } from "./build-tree.ts";
import { useSpanSelection } from "./span-selection.tsx";
import type { SpanRow, TraceScale, TreeRow, TurnRow, UntimedGroupRow } from "./trace-tree.types.ts";
import { vocabPalette, vocabShortLabel } from "./vocab.ts";

const INDENT_PX = 16;
const CHEVRON_COL_PX = 28;
const DOT_COL_PX = 20;
const NAME_COL_PX = 232;
const STICKY_LEFT_TOTAL_PX = CHEVRON_COL_PX + DOT_COL_PX + NAME_COL_PX;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.5;

interface TraceTreeProps {
	turns: readonly ReplayTurnResponse[];
	spans: readonly SpanResponse[];
	replayStartIso: string;
	zoom: number;
}

type RenderState =
	| { kind: "empty" }
	| { kind: "ready"; rows: readonly TreeRow[]; scale: TraceScale };

export function TraceTree({ turns, spans, replayStartIso, zoom }: TraceTreeProps) {
	const state = useMemo<RenderState>(() => {
		const { rows, scale } = buildTree(turns, spans, replayStartIso);
		if (rows.length === 0) return { kind: "empty" };
		return { kind: "ready", rows, scale };
	}, [turns, spans, replayStartIso]);

	return match(state)
		.with({ kind: "empty" }, () => <TraceTreeEmpty />)
		.with({ kind: "ready" }, (s) => <TraceTreeReady rows={s.rows} scale={s.scale} zoom={zoom} />)
		.exhaustive();
}

function TraceTreeReady({
	rows,
	scale,
	zoom,
}: {
	rows: readonly TreeRow[];
	scale: TraceScale;
	zoom: number;
}) {
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
	const visible = useMemo(() => filterCollapsed(rows, collapsed), [rows, collapsed]);
	const player = usePlayer();

	const toggle = (id: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	// Clicks anywhere in the app that DON'T land on a `data-keep-trace-highlight`
	// element clear the current waveform highlight. Document-level listener
	// so clicks in the sidebar / header / breadcrumbs / run-details panel
	// also count as "moved on from this selection", not just clicks inside
	// the trace tree. Row seek buttons + the audio player container opt out
	// via `data-keep-trace-highlight="true"` — those clicks either update
	// the highlight themselves (row seek) or want to preserve it (play/pause).
	// Synchronizes external state (DOM events) with React → effect is the
	// right tool per the rules.
	const { clearHighlight } = player;
	useEffect(() => {
		const onClick = (event: MouseEvent) => {
			const target = event.target instanceof Element ? event.target : null;
			if (target === null) return;
			if (target.closest("[data-keep-trace-highlight='true']") !== null) return;
			clearHighlight();
		};
		document.addEventListener("click", onClick);
		return () => document.removeEventListener("click", onClick);
	}, [clearHighlight]);

	// Bar area scales by zoom. The left columns are fixed-width sticky cells
	// so the timeline area takes the remaining viewport width × zoom.
	const virtualWidth = `calc(${STICKY_LEFT_TOTAL_PX}px + (100% - ${STICKY_LEFT_TOTAL_PX}px) * ${zoom})`;

	return (
		<div className="h-full overflow-auto">
			<div className="relative" style={{ width: virtualWidth, minWidth: "100%" }}>
				<TimeRuler scale={scale} zoom={zoom} />
				<ol className="divide-y divide-border/30">
					{visible.map((row) => (
						<TreeRowItem
							key={row.id}
							row={row}
							scale={scale}
							isCollapsed={collapsed.has(row.id)}
							onToggle={() => toggle(row.id)}
						/>
					))}
				</ol>
				<TracePlayhead scale={scale} />
			</div>
		</div>
	);
}

function TreeRowItem({
	row,
	scale,
	isCollapsed,
	onToggle,
}: {
	row: TreeRow;
	scale: TraceScale;
	isCollapsed: boolean;
	onToggle: () => void;
}) {
	return match(row)
		.with({ kind: "turn" }, (r) => (
			<TurnRowItem row={r} scale={scale} isCollapsed={isCollapsed} onToggle={onToggle} />
		))
		.with({ kind: "span" }, (r) => (
			<SpanRowItem row={r} scale={scale} isCollapsed={isCollapsed} onToggle={onToggle} />
		))
		.with({ kind: "untimed-group" }, (r) => (
			<UntimedRowItem row={r} isCollapsed={isCollapsed} onToggle={onToggle} />
		))
		.exhaustive();
}

function TurnRowItem({
	row,
	scale,
	isCollapsed,
	onToggle,
}: {
	row: TurnRow;
	scale: TraceScale;
	isCollapsed: boolean;
	onToggle: () => void;
}) {
	const player = usePlayer();
	const isUser = row.role === "user";

	const onSeek = () => {
		player.seek(row.startedAtSec);
		player.highlight(row.startedAtSec, row.endedAtSec);
	};

	const stickyBg = isUser ? "rgb(13 24 38)" : "rgb(34 22 14)";
	const accent = isUser ? "rgb(56 189 248)" : "rgb(251 146 60)";
	return (
		<li className="group/row relative">
			<div
				className="flex h-9 items-stretch border-t border-border/40 transition-colors"
				style={{ background: stickyBg, boxShadow: `inset 3px 0 0 0 ${accent}` }}
			>
				<div
					className="sticky left-0 z-10 flex shrink-0 items-center justify-center"
					style={{ width: CHEVRON_COL_PX, background: stickyBg }}
				>
					<ExpandToggle
						hasChildren={row.hasChildren}
						isCollapsed={isCollapsed}
						onToggle={onToggle}
					/>
				</div>
				<div
					className="sticky z-10 flex shrink-0 items-center justify-center"
					style={{
						left: CHEVRON_COL_PX,
						width: DOT_COL_PX,
						background: stickyBg,
					}}
				>
					<span
						aria-hidden="true"
						className={cn(
							"size-1.5 rounded-full",
							isUser
								? "bg-sky-400 shadow-[0_0_6px_rgb(56_189_248/0.75)]"
								: "bg-orange-400 shadow-[0_0_6px_rgb(251_146_60/0.75)]",
						)}
					/>
				</div>
				<button
					type="button"
					onClick={onSeek}
					data-keep-trace-highlight="true"
					aria-label={`Seek to turn ${row.idx + 1}, ${row.role}`}
					className="sticky z-10 flex shrink-0 items-center gap-2 overflow-hidden pr-3 text-left hover:bg-foreground/[0.04]"
					style={{
						left: CHEVRON_COL_PX + DOT_COL_PX,
						width: NAME_COL_PX,
						background: stickyBg,
					}}
				>
					<span className="font-mono text-[10px] tabular-nums tracking-[0.18em] text-muted-foreground/70">
						T{String(row.idx + 1).padStart(2, "0")}
					</span>
					<span
						className={cn(
							"inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em]",
							isUser ? "bg-sky-400 text-sky-950" : "bg-orange-400 text-orange-950",
						)}
					>
						{isUser ? "User" : "Agent"}
					</span>
					<span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/70">
						{formatDurationMs(row.durationMs)}
					</span>
				</button>
				<TimeBar
					scale={scale}
					startSec={row.startedAtSec}
					endSec={row.endedAtSec}
					onSeek={onSeek}
					ariaLabel={`Seek to turn ${row.idx + 1} bar`}
					emphasis="turn"
					colorFill={isUser ? "rgb(56 189 248 / 0.55)" : "rgb(251 146 60 / 0.55)"}
					colorOutline={isUser ? "rgb(56 189 248)" : "rgb(251 146 60)"}
				/>
			</div>
		</li>
	);
}

function SpanRowItem({
	row,
	scale,
	isCollapsed,
	onToggle,
}: {
	row: SpanRow;
	scale: TraceScale;
	isCollapsed: boolean;
	onToggle: () => void;
}) {
	const player = usePlayer();
	const { selectedSpanId, select } = useSpanSelection();
	const palette = vocabPalette(row.vocabulary);
	const isSelected = selectedSpanId === row.span.span_id;

	// One "focus this span" gesture: move the playhead, shade the waveform,
	// and open the span in the detail panel. Both the name cell and the bar
	// trigger it, so clicking anywhere on the row inspects the span.
	const onActivate = () => {
		player.seek(row.startedAtSec);
		player.highlight(row.startedAtSec, row.endedAtSec);
		select(row.span.span_id);
	};

	const stickyBg = isSelected ? "rgb(30 28 24)" : "rgb(15 15 15)";
	return (
		<li className="group/row relative">
			<div
				className="relative flex h-8 items-stretch transition-colors"
				style={isSelected ? { boxShadow: `inset 2px 0 0 0 ${palette.barOutline}` } : undefined}
			>
				<div
					className="sticky left-0 z-10 flex shrink-0 items-center justify-center"
					style={{ width: CHEVRON_COL_PX, background: stickyBg }}
				>
					<IndentGuides depth={row.depth} />
					<ExpandToggle
						hasChildren={row.hasChildren}
						isCollapsed={isCollapsed}
						onToggle={onToggle}
					/>
				</div>
				<div
					className="sticky z-10 flex shrink-0 items-center justify-center"
					style={{
						left: CHEVRON_COL_PX,
						width: DOT_COL_PX,
						background: stickyBg,
					}}
				>
					<span aria-hidden="true" className={cn("size-1.5 rounded-full", palette.dotBg)} />
				</div>
				<button
					type="button"
					onClick={onActivate}
					data-keep-trace-highlight="true"
					aria-current={isSelected ? "true" : undefined}
					aria-label={`Inspect ${row.vocabulary} span ${row.name}`}
					className="sticky z-10 flex shrink-0 items-center gap-2 overflow-hidden pr-3 text-left hover:bg-foreground/[0.04]"
					style={{
						left: CHEVRON_COL_PX + DOT_COL_PX,
						width: NAME_COL_PX,
						background: stickyBg,
					}}
				>
					<span
						title={row.vocabulary}
						className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60"
					>
						{vocabShortLabel(row.vocabulary)}
					</span>
					<span className={cn("truncate font-mono text-[12px]", palette.text)}>{row.name}</span>
					<span className="ml-auto pl-3 font-mono text-[10px] tabular-nums text-muted-foreground/70">
						{formatDurationMs(row.durationMs)}
					</span>
				</button>
				<TimeBar
					scale={scale}
					startSec={row.startedAtSec}
					endSec={row.endedAtSec}
					onSeek={onActivate}
					ariaLabel={`Inspect span ${row.name} bar`}
					emphasis="span"
					colorFill={palette.barFill}
					colorOutline={palette.barOutline}
				/>
			</div>
		</li>
	);
}

function UntimedRowItem({
	row,
	isCollapsed,
	onToggle,
}: {
	row: UntimedGroupRow;
	isCollapsed: boolean;
	onToggle: () => void;
}) {
	const stickyBg = "rgb(22 22 22)";
	return (
		<li>
			<div
				className="flex h-8 items-stretch"
				style={{
					boxShadow:
						"inset 2px 0 0 0 color-mix(in oklch, var(--color-muted-foreground) 30%, transparent)",
				}}
			>
				<div
					className="sticky left-0 z-10 flex shrink-0 items-center justify-center"
					style={{ width: CHEVRON_COL_PX, background: stickyBg }}
				>
					<ExpandToggle
						hasChildren={row.hasChildren}
						isCollapsed={isCollapsed}
						onToggle={onToggle}
					/>
				</div>
				<div
					className="sticky z-10 flex shrink-0 items-center justify-center"
					style={{ left: CHEVRON_COL_PX, width: DOT_COL_PX, background: stickyBg }}
				>
					<span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground/50" />
				</div>
				<div
					className="sticky z-10 flex shrink-0 items-center gap-2 pr-3"
					style={{
						left: CHEVRON_COL_PX + DOT_COL_PX,
						width: NAME_COL_PX,
						background: stickyBg,
					}}
				>
					<span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/80">
						orph
					</span>
					<span className="text-[13px] font-semibold tracking-tight text-muted-foreground">
						Untimed
					</span>
					<span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/80">
						{row.spanCount} {row.spanCount === 1 ? "span" : "spans"}
					</span>
				</div>
				<div className="min-w-0 flex-1" />
			</div>
		</li>
	);
}

function TimeRuler({ scale, zoom }: { scale: TraceScale; zoom: number }) {
	const ticks = useMemo(() => buildTicks(scale, zoom), [scale, zoom]);
	const stickyBg = "rgb(20 20 22)";
	return (
		<div className="sticky top-0 z-20 flex h-8 items-stretch border-b border-border/60">
			<div
				className="sticky left-0 z-10 flex shrink-0 items-center justify-center border-r border-border/40"
				style={{ width: CHEVRON_COL_PX, background: stickyBg }}
			/>
			<div
				className="sticky z-10 flex shrink-0 items-center justify-center"
				style={{ left: CHEVRON_COL_PX, width: DOT_COL_PX, background: stickyBg }}
			/>
			<div
				className="sticky z-10 flex shrink-0 items-center px-3"
				style={{
					left: CHEVRON_COL_PX + DOT_COL_PX,
					width: NAME_COL_PX,
					background: stickyBg,
				}}
			>
				<span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/80">
					Span / call
				</span>
			</div>
			<div className="relative min-w-0 flex-1" style={{ background: stickyBg }}>
				{ticks.map((tick) => (
					<div
						key={tick.sec}
						className="absolute top-0 bottom-0 flex flex-col items-start"
						style={{ left: `${tick.leftPct}%` }}
					>
						<span className="absolute top-1 left-1 font-mono text-[10px] tabular-nums text-muted-foreground/80">
							{formatClock(tick.sec)}
						</span>
						<div aria-hidden="true" className="absolute bottom-0 h-2 w-px bg-border" />
					</div>
				))}
			</div>
		</div>
	);
}

export const ZOOM_MIN = MIN_ZOOM;
export const ZOOM_MAX = MAX_ZOOM;
export const ZOOM_STEP_FACTOR = ZOOM_STEP;

export function ZoomControls({ zoom, onChange }: { zoom: number; onChange: (z: number) => void }) {
	const canOut = zoom > MIN_ZOOM + 1e-3;
	const canIn = zoom < MAX_ZOOM - 1e-3;
	return (
		<div className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-1 py-0.5">
			<button
				type="button"
				disabled={!canOut}
				onClick={() => onChange(Math.max(MIN_ZOOM, zoom / ZOOM_STEP))}
				aria-label="Zoom out"
				className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
			>
				<MinusIcon className="size-3.5" />
			</button>
			<span className="min-w-9 text-center font-mono text-[11px] tabular-nums text-foreground/90">
				{zoom.toFixed(1)}×
			</span>
			<button
				type="button"
				disabled={!canIn}
				onClick={() => onChange(Math.min(MAX_ZOOM, zoom * ZOOM_STEP))}
				aria-label="Zoom in"
				className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
			>
				<PlusIcon className="size-3.5" />
			</button>
		</div>
	);
}

/**
 * Position of `sec` along the trace timeline as a 0..1 fraction, clamped to
 * the visible range and 0 for a degenerate (zero-duration / non-finite) scale.
 * The single source of truth for horizontal placement — `TimeBar` and the
 * playhead cursor both derive from it so a bar and the cursor over it can
 * never drift apart.
 */
export function fractionOf(sec: number, scale: TraceScale): number {
	const raw = (sec - scale.startSec) / scale.durationSec;
	if (!Number.isFinite(raw)) return 0;
	return Math.max(0, Math.min(1, raw));
}

/**
 * CSS `left` for a 0..1 fraction, placing it within the timeline region
 * [STICKY_LEFT_TOTAL_PX, virtualWidth]. `100%` resolves to the inner
 * container's width (== virtualWidth), so `STICKY_LEFT_TOTAL_PX + f·(100% −
 * STICKY_LEFT_TOTAL_PX)` lands on the exact x a `TimeBar` bar at fraction `f`
 * occupies — at any zoom, since zoom only changes the resolved `100%`.
 */
export function playheadLeft(fraction: number): string {
	return `calc(${STICKY_LEFT_TOTAL_PX}px + ${fraction} * (100% - ${STICKY_LEFT_TOTAL_PX}px))`;
}

/**
 * Vertical cursor synced to the audio playhead, overlaid across the whole
 * tree at the same horizontal scale as the `TimeBar`s. Left is built so the
 * timeline region [STICKY_LEFT_TOTAL_PX, virtualWidth] maps the fraction
 * exactly onto a bar at the same fraction — `100%` resolves to the inner
 * container's width (== virtualWidth), so it tracks zoom with no extra wiring.
 * Decorative: `aria-hidden` + `pointer-events-none` so it never intercepts a
 * row's seek click. Hidden until the player is ready (no audio → no cursor).
 */
function TracePlayhead({ scale }: { scale: TraceScale }) {
	const { isReady } = usePlayer();
	const { sec, playing } = usePlayhead();
	if (!isReady) return null;
	return (
		<div
			data-testid="trace-playhead"
			aria-hidden="true"
			className="pointer-events-none absolute inset-y-0 z-30"
			style={{ left: playheadLeft(fractionOf(sec, scale)) }}
		>
			<div
				className={cn(
					"absolute inset-y-0 left-0 w-px -translate-x-1/2 bg-white/85",
					playing
						? "shadow-[0_0_10px_rgba(255,255,255,0.7)]"
						: "shadow-[0_0_6px_rgba(255,255,255,0.4)]",
				)}
			/>
			<div className="sticky top-1 left-0 -translate-x-1/2 whitespace-nowrap rounded bg-white px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-zinc-950 shadow-sm">
				{formatClockSeconds(sec)}
			</div>
		</div>
	);
}

function TimeBar({
	scale,
	startSec,
	endSec,
	onSeek,
	ariaLabel,
	emphasis,
	colorFill,
	colorOutline,
}: {
	scale: TraceScale;
	startSec: number;
	endSec: number;
	onSeek: () => void;
	ariaLabel: string;
	emphasis: "turn" | "span";
	colorFill: string;
	colorOutline: string;
}) {
	const leftPct = fractionOf(startSec, scale) * 100;
	const widthPct = Math.max(((endSec - startSec) / scale.durationSec) * 100, 0.4);
	return (
		<button
			type="button"
			onClick={onSeek}
			data-keep-trace-highlight="true"
			aria-label={ariaLabel}
			className="group/bar relative h-full w-full overflow-hidden hover:bg-foreground/[0.04]"
		>
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-y-0 left-0 right-0 bg-[linear-gradient(to_right,transparent_0,transparent_calc(100%/12-1px),rgba(255,255,255,0.025)_calc(100%/12-1px),rgba(255,255,255,0.025)_calc(100%/12))] bg-[length:8.33%_100%]"
			/>
			<div
				className={cn(
					"absolute top-1/2 -translate-y-1/2 rounded-[2px] transition-all",
					emphasis === "turn" ? "h-4" : "h-2.5",
				)}
				style={{
					left: `${leftPct}%`,
					width: `${widthPct}%`,
					background: colorFill,
					boxShadow: `0 0 0 1px ${colorOutline}`,
				}}
			/>
		</button>
	);
}

function ExpandToggle({
	hasChildren,
	isCollapsed,
	onToggle,
}: {
	hasChildren: boolean;
	isCollapsed: boolean;
	onToggle: () => void;
}) {
	if (!hasChildren) return <span aria-hidden="true" className="block size-3.5 shrink-0" />;
	const Icon = isCollapsed ? ChevronRightIcon : ChevronDownIcon;
	return (
		<button
			type="button"
			aria-label={isCollapsed ? "Expand" : "Collapse"}
			onClick={(e) => {
				e.stopPropagation();
				onToggle();
			}}
			className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
		>
			<Icon className="size-3" />
		</button>
	);
}

function IndentGuides({ depth }: { depth: number }) {
	if (depth === 0) return null;
	const guideColor = "color-mix(in oklch, var(--color-border) 55%, transparent)";
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-y-0 left-0"
			style={{
				width: `${depth * INDENT_PX}px`,
				backgroundImage: `repeating-linear-gradient(to right, transparent 0, transparent ${INDENT_PX - 1}px, ${guideColor} ${INDENT_PX - 1}px, ${guideColor} ${INDENT_PX}px)`,
				backgroundPosition: `${INDENT_PX + 2}px 0`,
				backgroundRepeat: "repeat-x",
			}}
		/>
	);
}

function TraceTreeEmpty() {
	return (
		<div className="relative flex h-full flex-col items-center justify-center overflow-hidden px-8 text-center">
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 opacity-[0.05]"
				style={{
					backgroundImage:
						"linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
					backgroundSize: "18px 18px",
				}}
			/>
			<p className="relative font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70">
				∅ trace
			</p>
			<h3 className="relative mt-3 font-semibold text-lg tracking-tight text-foreground/90">
				No spans recorded
			</h3>
			<p className="relative mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
				Decorate your agent with{" "}
				<code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground/90">
					@xray.trace.stage(...)
				</code>{" "}
				to populate this panel.
			</p>
			<p className="relative mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/50">
				see docs/SDK.md
			</p>
		</div>
	);
}

function filterCollapsed(
	rows: readonly TreeRow[],
	collapsed: ReadonlySet<string>,
): readonly TreeRow[] {
	const out: TreeRow[] = [];
	const hiddenStack: { id: string; depth: number }[] = [];
	for (const row of rows) {
		while (hiddenStack.length > 0) {
			const top = hiddenStack[hiddenStack.length - 1];
			if (top === undefined) break;
			if (row.depth > top.depth) break;
			hiddenStack.pop();
		}
		if (hiddenStack.length > 0) continue;
		out.push(row);
		if (collapsed.has(row.id) && row.hasChildren) {
			hiddenStack.push({ id: row.id, depth: row.depth });
		}
	}
	return out;
}

function buildTicks(scale: TraceScale, zoom: number): { sec: number; leftPct: number }[] {
	// More zoom = more horizontal space = more ticks fit. Target tick count
	// scales with zoom so labels don't crowd at 1× or sparsify at 8×.
	const step = niceTickStep(scale.durationSec / zoom);
	const out: { sec: number; leftPct: number }[] = [];
	const first = Math.ceil(scale.startSec / step) * step;
	for (let s = first; s <= scale.endSec + 1e-6; s += step) {
		const leftPct = ((s - scale.startSec) / scale.durationSec) * 100;
		if (leftPct < 0 || leftPct > 100) continue;
		out.push({ sec: Number.isInteger(s) ? s : Number(s.toFixed(3)), leftPct });
	}
	return out;
}

function niceTickStep(durationSec: number): number {
	const targetTicks = 7;
	const rough = durationSec / targetTicks;
	const candidates = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
	for (const c of candidates) if (c >= rough) return c;
	return 600;
}

function formatClock(seconds: number): string {
	if (!Number.isFinite(seconds)) return "—";
	const sign = seconds < 0 ? "-" : "";
	const safe = Math.abs(seconds);
	if (safe < 10) return `${sign}${safe.toFixed(2)}s`;
	// Round to deciseconds BEFORE splitting into minutes/seconds, otherwise
	// the seconds field can render as "60.0" when the source value rounds up
	// across the minute boundary (e.g. 59.96 → "00:60.0" instead of "01:00.0").
	const totalTenths = Math.round(safe * 10);
	const totalWholeSec = Math.floor(totalTenths / 10);
	const tenth = totalTenths % 10;
	const minutes = Math.floor(totalWholeSec / 60);
	const secInMin = totalWholeSec - minutes * 60;
	return `${sign}${String(minutes).padStart(2, "0")}:${String(secInMin).padStart(2, "0")}.${tenth}`;
}
