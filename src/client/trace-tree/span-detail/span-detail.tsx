import { XIcon } from "lucide-react";
import { match } from "ts-pattern";

import type {
	ModelUsageResponse,
	ReplayDetailResponse,
	SpanResponse,
	ToolCallResponse,
} from "@/client/api/api.types.ts";
import { JsonTree, jsonTreeOrNull } from "@/client/components/json-tree.tsx";
import { formatClockSeconds, formatDurationMs } from "@/client/format.ts";
import { isJsonContainer } from "@/client/lib/json.ts";
import { cn } from "@/client/lib/utils.ts";

import { useSpanSelection } from "../span-selection.tsx";
import { vocabLabel, vocabPalette, vocabShortLabel } from "../vocab.ts";
import type { AttributeEntry, SpanAttributes, SpanDetailModel } from "./span-detail.types.ts";
import { resolveSpanDetail } from "./span-detail-model.ts";

/**
 * Bottom drawer of the span-tree card: resolves the selected span from the
 * replay and renders its detail directly under the tree row it came from
 * (nothing when the replay has no spans, a one-line hint until the user picks
 * one). Derived at render — no effect, no second source of truth (see
 * no-effect-for-data rule).
 */
export function SpanDetailDrawer({ replay }: { replay: ReplayDetailResponse }) {
	const { selectedSpanId, clear } = useSpanSelection();
	if (replay.spans.length === 0) return null;
	const detail = resolveSpanDetail(selectedSpanId, {
		spans: replay.spans,
		modelUsage: replay.model_usage,
		toolCalls: replay.tool_calls,
	});
	if (detail === null) return <SpanDetailHint />;
	// Re-key on the span so switching selection replays the entrance animation.
	return <SpanDetailPanel key={detail.span.span_id} detail={detail} onClose={clear} />;
}

/**
 * Nudges the drawer into view on open. The tree above it is a tall fixed-height
 * pane, so a span picked near its bottom would otherwise reveal the detail
 * below the fold and read as a no-op. `nearest` scrolls the minimum needed —
 * nothing at all when the drawer already sits on screen. Re-keyed per selection
 * (see `SpanDetailDrawer`), so it fires on every span click, not just the first.
 */
function scrollSpanDetailIntoView(node: HTMLElement | null): void {
	if (node === null) return;
	node.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

export function SpanDetailPanel({
	detail,
	onClose,
}: {
	detail: SpanDetailModel;
	onClose: () => void;
}) {
	const palette = vocabPalette(detail.span.vocabulary);
	return (
		<section
			ref={scrollSpanDetailIntoView}
			aria-label={`Span detail: ${detail.span.name}`}
			className="relative border-t border-border/60 animate-in fade-in-0 slide-in-from-top-1 duration-300 ease-out"
		>
			<div
				aria-hidden="true"
				className="absolute inset-x-0 top-0 z-10 h-px"
				style={{ background: palette.barOutline }}
			/>
			<SpanDetailHeader span={detail.span} durationMs={detail.durationMs} onClose={onClose} />
			{/* Fixed rail for the facts, the rest for attributes — the drawer is as
			    wide as the tree, and a single column would stretch every attribute
			    value across the whole card. The drawer itself takes its height from
			    its content (the tree above already caps, so the card stays
			    navigable); an unparsed raw attribute bag is the one thing left that
			    caps its own height, in `RawAttributes`. */}
			<div className="grid lg:grid-cols-[19rem_minmax(0,1fr)]">
				<div className="divide-y divide-border/50 lg:border-r lg:border-border/50">
					<SpanFactsSection detail={detail} />
					{detail.usage.length > 0 && <LinkedUsageSection usage={detail.usage} />}
					{detail.toolCalls.length > 0 && <LinkedToolSection toolCalls={detail.toolCalls} />}
				</div>
				<div className="border-t border-border/50 lg:border-t-0">
					<AttributesSection attributes={detail.attributes} />
				</div>
			</div>
		</section>
	);
}

function SpanDetailHint() {
	return (
		<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border/60 bg-foreground/[0.015] px-5 py-3">
			<span
				aria-hidden="true"
				className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground/45"
			>
				◎ inspector
			</span>
			<p className="text-xs text-muted-foreground/75">
				Select a span above to inspect its attributes, timing, and linked model + tool calls.
			</p>
		</div>
	);
}

function SpanDetailHeader({
	span,
	durationMs,
	onClose,
}: {
	span: SpanResponse;
	durationMs: number;
	onClose: () => void;
}) {
	const palette = vocabPalette(span.vocabulary);
	return (
		<div className="flex items-center gap-2.5 bg-foreground/[0.015] px-5 py-3">
			<span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", palette.dotBg)} />
			<h3
				className={cn(
					"min-w-0 truncate font-mono text-sm font-semibold tracking-tight",
					palette.text,
				)}
			>
				{span.name}
			</h3>
			<span
				className="shrink-0 rounded border px-1 py-0.5 font-mono text-[9px] uppercase leading-none"
				style={{ borderColor: palette.barOutline, color: palette.barOutline }}
			>
				{vocabShortLabel(span.vocabulary)}
			</span>
			<span className="hidden shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70 sm:inline">
				{vocabLabel(span.vocabulary)}
			</span>
			<span className="ml-auto shrink-0 font-mono text-lg font-semibold tabular-nums text-foreground">
				{formatDurationMs(durationMs)}
			</span>
			<button
				type="button"
				onClick={onClose}
				aria-label="Close span detail"
				className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
			>
				<XIcon className="size-3.5" />
			</button>
		</div>
	);
}

function SpanFactsSection({ detail }: { detail: SpanDetailModel }) {
	const { span } = detail;
	const isRoot = detail.parentName === null && span.parent_span_id === null;
	const parent = detail.parentName ?? span.parent_span_id ?? "root";
	return (
		<section className="space-y-3 px-5 py-4">
			<SectionLabel label="Span" />
			{/* Capped while the drawer is stacked — a right-aligned value a card-width
			    away from its label is unreadable. In the `lg` rail it's already narrow. */}
			<dl className="max-w-md space-y-1.5 lg:max-w-none">
				<FactRow
					label="Window"
					value={
						detail.startOffsetSec === null || detail.endOffsetSec === null
							? "—"
							: `${formatClockSeconds(detail.startOffsetSec)} → ${formatClockSeconds(detail.endOffsetSec)}`
					}
				/>
				<FactRow label="Id" value={span.span_id} />
				<FactRow label="Trace" value={span.trace_id} />
				<FactRow label="Parent" value={parent} dim={isRoot} />
			</dl>
		</section>
	);
}

function FactRow({ label, value, dim = false }: { label: string; value: string; dim?: boolean }) {
	return (
		<div className="flex items-baseline gap-3 font-mono text-[11px]">
			<dt className="w-14 shrink-0 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/55">
				{label}
			</dt>
			<dd
				className={cn(
					"min-w-0 flex-1 truncate text-right tabular-nums",
					dim ? "text-muted-foreground/50" : "text-foreground/85",
				)}
				title={value}
			>
				{value}
			</dd>
		</div>
	);
}

function LinkedUsageSection({ usage }: { usage: readonly ModelUsageResponse[] }) {
	return (
		<section className="space-y-3 px-5 py-4">
			<SectionLabel label="Model usage" meta={usage.length > 1 ? `${usage.length} calls` : null} />
			<ul className="space-y-3.5">
				{usage.map((u) => (
					<UsageRow key={u.id} usage={u} />
				))}
			</ul>
		</section>
	);
}

function UsageRow({ usage: u }: { usage: ModelUsageResponse }) {
	return (
		<li className="space-y-2 font-mono text-[11px]">
			<div className="flex items-baseline justify-between gap-2">
				<span className="min-w-0 truncate text-foreground">
					{u.model ?? "—"}
					{u.provider !== null && <span className="text-muted-foreground"> /{u.provider}</span>}
				</span>
				<span className="flex shrink-0 items-baseline gap-2 tabular-nums text-muted-foreground">
					{u.ttft_ms !== null && (
						<span title="Time to first token">
							<span className="text-muted-foreground/60">ttft</span> {u.ttft_ms}ms
						</span>
					)}
					{u.latency_ms !== null && <span>{u.latency_ms}ms</span>}
				</span>
			</div>
			<TokenBar input={u.input_tokens} output={u.output_tokens} />
			<div className="flex gap-3 text-[10px] tabular-nums text-muted-foreground/80">
				<span>
					<span className="text-sky-300/80">in</span> {formatCount(u.input_tokens)}
				</span>
				<span>
					<span className="text-amber-300/80">out</span> {formatCount(u.output_tokens)}
				</span>
				<span className="ml-auto text-foreground/80">total {formatCount(u.total_tokens)}</span>
			</div>
		</li>
	);
}

/**
 * Input-vs-output token split. `aria-hidden` because the exact counts sit
 * directly beneath it.
 */
function TokenBar({ input, output }: { input: number | null; output: number | null }) {
	const inTokens = input ?? 0;
	const outTokens = output ?? 0;
	const total = inTokens + outTokens;
	if (total === 0) return null;
	const inPct = (inTokens / total) * 100;
	return (
		<div aria-hidden="true" className="flex h-1.5 overflow-hidden rounded-full bg-muted/40">
			<div className="bg-sky-400/70" style={{ width: `${inPct}%` }} />
			<div className="bg-amber-400/70" style={{ width: `${100 - inPct}%` }} />
		</div>
	);
}

/**
 * Summary only — name and latency, no args/result. A tool call is linked by
 * `span_id` (see `resolveSpanDetail`), so every row here was emitted by the span
 * on screen, and both vocabularies keep the attributes they extracted the
 * payload from. Rendering the JSON here too would print it twice side by side
 * with the attribute column, which is what the pre-drawer layout got away with
 * only because it stacked the two.
 */
function LinkedToolSection({ toolCalls }: { toolCalls: readonly ToolCallResponse[] }) {
	return (
		<section className="space-y-3 px-5 py-4">
			<SectionLabel label="Tool calls" meta={`${toolCalls.length}`} />
			<ul className="space-y-2">
				{toolCalls.map((tc) => (
					<li
						key={tc.id}
						className="flex items-baseline justify-between gap-3 font-mono text-[11px]"
					>
						<span className="truncate font-medium text-foreground">{tc.name}</span>
						{tc.latency_ms !== null && (
							<span className="shrink-0 tabular-nums text-muted-foreground">
								{formatDurationMs(tc.latency_ms)}
							</span>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}

function AttributesSection({ attributes }: { attributes: SpanAttributes }) {
	return (
		<section className="space-y-3 px-5 py-4">
			<SectionLabel
				label="Attributes"
				meta={attributes.kind === "parsed" ? `${attributes.entries.length}` : null}
			/>
			{match(attributes)
				.with({ kind: "raw" }, (a) => <RawAttributes raw={a.raw} />)
				.with({ kind: "parsed" }, (a) =>
					a.entries.length === 0 ? (
						<p className="font-mono text-[11px] text-muted-foreground/60">
							No attributes recorded.
						</p>
					) : (
						// The attribute bag is the tallest thing in the drawer, so it
						// columnizes into whatever width is actually available — a viewport
						// breakpoint would guess wrong, since the drawer only gets the
						// remainder of the card after the facts rail.
						<ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-x-8 gap-y-2.5">
							{a.entries.map((entry) => (
								<AttributeRow key={entry.key} entry={entry} />
							))}
						</ul>
					),
				)
				.exhaustive()}
		</section>
	);
}

function RawAttributes({ raw }: { raw: string }) {
	return (
		<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/40 bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-foreground/90">
			{raw}
		</pre>
	);
}

function AttributeRow({ entry }: { entry: AttributeEntry }) {
	return (
		<li className="min-w-0 space-y-1">
			<div className="break-words font-mono text-[10px] tracking-tight">
				{entry.namespace !== "" && (
					<span className="text-muted-foreground/45">{entry.namespace}.</span>
				)}
				<span className="text-foreground/70">{entry.leaf}</span>
			</div>
			{/* Scrolls rather than clips: a container value (a JSON tree, indented per
			    level) can outrun a grid cell, and the host card is `overflow-hidden`,
			    so without this an unbroken token is simply unreachable. */}
			<div className="overflow-x-auto pl-2 font-mono text-[11px] leading-relaxed">
				<AttributeValue value={entry.value} />
			</div>
		</li>
	);
}

/**
 * Render an attribute value by its runtime JSON type — strings that are
 * themselves JSON (e.g. `langfuse.observation.input`) get the tree treatment.
 * `value` is `unknown`, narrowed here rather than upstream.
 */
function AttributeValue({ value }: { value: unknown }) {
	if (typeof value === "string") {
		return (
			jsonTreeOrNull(value) ?? (
				<span className="whitespace-pre-wrap break-words text-emerald-300/90">
					{value === "" ? '""' : value}
				</span>
			)
		);
	}
	if (typeof value === "number") {
		return <span className="tabular-nums text-orange-300/90">{value}</span>;
	}
	if (typeof value === "boolean") {
		return <span className="text-orange-300/90">{String(value)}</span>;
	}
	if (value === null) {
		return <span className="text-muted-foreground/60">null</span>;
	}
	if (isJsonContainer(value)) return <JsonTree data={value} />;
	return <span className="text-muted-foreground/60">—</span>;
}

function SectionLabel({ label, meta }: { label: string; meta?: string | null }) {
	return (
		<div className="flex items-baseline justify-between gap-3">
			<h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-foreground/70">
				{label}
			</h3>
			{meta !== null && meta !== undefined && (
				<span className="font-mono text-[10px] tracking-wide text-muted-foreground/70 tabular-nums">
					{meta}
				</span>
			)}
		</div>
	);
}

function formatCount(value: number | null): string {
	return value === null ? "—" : value.toLocaleString();
}
