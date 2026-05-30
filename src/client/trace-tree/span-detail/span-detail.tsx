import { XIcon } from "lucide-react";
import { match } from "ts-pattern";

import type {
	ModelUsageResponse,
	ReplayDetailResponse,
	SpanResponse,
	ToolCallResponse,
} from "@/client/api/api.types.ts";
import { JsonOrText, JsonTree } from "@/client/components/json-tree.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card.tsx";
import { formatClockSeconds, formatDurationMs } from "@/client/format.ts";
import { isJsonContainer, safeParseJson } from "@/client/lib/json.ts";
import { cn } from "@/client/lib/utils.ts";

import { useSpanSelection } from "../span-selection.tsx";
import { vocabLabel, vocabPalette, vocabShortLabel } from "../vocab.ts";
import type { AttributeEntry, SpanAttributes, SpanDetailModel } from "./span-detail.types.ts";
import { resolveSpanDetail } from "./span-detail-model.ts";

/**
 * Right-column companion to the trace tree: resolves the selected span from
 * the replay (spans + the model_usage / tool_calls it links by span_id) and
 * renders its full detail. Renders nothing when the replay has no spans, and
 * a discoverability prompt until the user picks one. The detail is derived at
 * render — no effect, no second source of truth (see no-effect-for-data rule).
 */
export function SpanDetailAside({ replay }: { replay: ReplayDetailResponse }) {
	const { selectedSpanId, clear } = useSpanSelection();
	if (replay.spans.length === 0) return null;
	const detail = resolveSpanDetail(selectedSpanId, {
		replayStartIso: replay.started_at,
		spans: replay.spans,
		modelUsage: replay.model_usage,
		toolCalls: replay.tool_calls,
	});
	if (detail === null) return <SpanDetailEmpty />;
	// Re-key on the span so switching selection replays the entrance animation.
	return <SpanDetailPanel key={detail.span.span_id} detail={detail} onClose={clear} />;
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
		<Card className="relative gap-0 overflow-hidden p-0 animate-in fade-in-0 duration-300 ease-out lg:absolute lg:inset-0 lg:flex lg:flex-col lg:slide-in-from-right-3">
			<div
				aria-hidden="true"
				className="absolute inset-x-0 top-0 z-10 h-px"
				style={{ background: palette.barOutline }}
			/>
			<SpanDetailHeader span={detail.span} onClose={onClose} />
			<CardContent className="scroll-panel divide-y divide-border/50 p-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
				<SpanTimingGrid detail={detail} />
				{detail.usage.length > 0 && <LinkedUsageSection usage={detail.usage} />}
				{detail.toolCalls.length > 0 && <LinkedToolSection toolCalls={detail.toolCalls} />}
				<AttributesSection attributes={detail.attributes} />
			</CardContent>
		</Card>
	);
}

function SpanDetailHeader({ span, onClose }: { span: SpanResponse; onClose: () => void }) {
	const palette = vocabPalette(span.vocabulary);
	return (
		<CardHeader className="gap-0 border-b border-border/60 px-5 py-4 lg:shrink-0">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 space-y-1.5">
					<div className="flex items-center gap-2">
						<span
							aria-hidden="true"
							className={cn("size-1.5 shrink-0 rounded-full", palette.dotBg)}
						/>
						<CardTitle
							className={cn(
								"truncate font-mono text-sm font-semibold tracking-tight",
								palette.text,
							)}
						>
							{span.name}
						</CardTitle>
					</div>
					<div className="flex items-center gap-2 pl-3.5">
						<span
							className="inline-flex items-center justify-center rounded border px-1 py-0.5 font-mono text-[9px] uppercase leading-none"
							style={{ borderColor: palette.barOutline, color: palette.barOutline }}
						>
							{vocabShortLabel(span.vocabulary)}
						</span>
						<span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70">
							{vocabLabel(span.vocabulary)}
						</span>
					</div>
				</div>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close span detail"
					className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
				>
					<XIcon className="size-3.5" />
				</button>
			</div>
		</CardHeader>
	);
}

function SpanTimingGrid({ detail }: { detail: SpanDetailModel }) {
	const { span } = detail;
	const isRoot = detail.parentName === null && span.parent_span_id === null;
	const parent = detail.parentName ?? span.parent_span_id ?? "root";
	return (
		<section className="space-y-3 px-5 py-4">
			<div className="flex items-baseline justify-between gap-3">
				<span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70">
					Duration
				</span>
				<span className="font-mono text-xl font-semibold tabular-nums text-foreground">
					{formatDurationMs(detail.durationMs)}
				</span>
			</div>
			<dl className="space-y-1.5">
				<FactRow
					label="Window"
					value={`${formatClockSeconds(detail.startOffsetSec)} → ${formatClockSeconds(detail.endOffsetSec)}`}
				/>
				<FactRow label="Span" value={span.span_id} />
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
				{u.latency_ms !== null && (
					<span className="shrink-0 tabular-nums text-muted-foreground">{u.latency_ms}ms</span>
				)}
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
 * Input-vs-output token split. Decorative — `aria-hidden` because the exact
 * counts sit directly beneath it; hidden entirely when there's nothing to show.
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

function LinkedToolSection({ toolCalls }: { toolCalls: readonly ToolCallResponse[] }) {
	return (
		<section className="space-y-3 px-5 py-4">
			<SectionLabel label="Tool calls" meta={`${toolCalls.length}`} />
			<ul className="space-y-2.5">
				{toolCalls.map((tc) => (
					<ToolRow key={tc.id} toolCall={tc} />
				))}
			</ul>
		</section>
	);
}

function ToolRow({ toolCall: tc }: { toolCall: ToolCallResponse }) {
	return (
		<li className="font-mono text-[11px]">
			<div className="flex items-baseline justify-between gap-3">
				<span className="truncate font-medium text-foreground">{tc.name}</span>
				{tc.latency_ms !== null && (
					<span className="shrink-0 tabular-nums text-muted-foreground">{tc.latency_ms}ms</span>
				)}
			</div>
			{(tc.args_json !== null || tc.result_json !== null) && (
				<dl className="mt-1 space-y-1 border-l border-border/40 pl-2.5 text-muted-foreground">
					{tc.args_json !== null && <JsonField label="args" raw={tc.args_json} />}
					{tc.result_json !== null && <JsonField label="result" raw={tc.result_json} />}
				</dl>
			)}
		</li>
	);
}

function JsonField({ label, raw }: { label: string; raw: string }) {
	return (
		<div className="flex gap-2">
			<dt className="shrink-0 text-muted-foreground/60">{label}</dt>
			<dd className="min-w-0 flex-1 overflow-auto">
				<JsonOrText raw={raw} />
			</dd>
		</div>
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
						<ul className="space-y-2.5">
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
		<li className="space-y-1">
			<div className="font-mono text-[10px] tracking-tight">
				{entry.namespace !== "" && (
					<span className="text-muted-foreground/45">{entry.namespace}.</span>
				)}
				<span className="text-foreground/70">{entry.leaf}</span>
			</div>
			<div className="pl-2 font-mono text-[11px] leading-relaxed">
				<AttributeValue value={entry.value} />
			</div>
		</li>
	);
}

/**
 * Render a single attribute value by its runtime JSON type — strings that are
 * themselves JSON (e.g. `langfuse.observation.input`) get the tree treatment;
 * plain strings, numbers and booleans get type-matched colors echoing the
 * JSON palette. `value` is `unknown` and narrowed here rather than upstream.
 */
function AttributeValue({ value }: { value: unknown }) {
	if (typeof value === "string") {
		const parsed = safeParseJson(value);
		if (parsed.ok && isJsonContainer(parsed.value)) return <JsonTree data={parsed.value} />;
		return (
			<span className="whitespace-pre-wrap break-words text-emerald-300/90">
				{value === "" ? '""' : value}
			</span>
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

function SpanDetailEmpty() {
	return (
		<Card className="relative gap-0 overflow-hidden p-0">
			<CardContent className="relative flex flex-col items-center justify-center overflow-hidden px-6 py-10 text-center">
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 opacity-[0.04]"
					style={{
						backgroundImage:
							"linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
						backgroundSize: "16px 16px",
					}}
				/>
				<p className="relative font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground/60">
					◎ inspector
				</p>
				<h3 className="relative mt-3 text-sm font-semibold tracking-tight text-foreground/90">
					Select a span
				</h3>
				<p className="relative mt-1.5 max-w-[26ch] text-xs leading-relaxed text-muted-foreground">
					Click any row in the span tree to inspect its attributes, timing, and linked model + tool
					calls.
				</p>
			</CardContent>
		</Card>
	);
}

function formatCount(value: number | null): string {
	return value === null ? "—" : value.toLocaleString();
}
