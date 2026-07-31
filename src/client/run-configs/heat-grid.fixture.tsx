import type { CompareRunConfigsResponse, RunConfigMetrics } from "@/client/api/api.types.ts";

import { ConfigChips } from "./config-chips.tsx";
import { splitConfigFacets } from "./config-facets.ts";
import { HeatGrid } from "./heat-grid.tsx";
import { rankedMetricRows } from "./heat-scale.ts";
import { makeRunConfigMetrics } from "./test-utils.ts";

const CONVERSATIONS = [
	"barge_in_recovery",
	"refund_flow",
	"tool_heavy_dispatch",
	"silence_handling",
	"multi_intent_booking",
	"accent_stress",
	"long_context_recall",
	"interruption_storm",
	"german_formality",
	"off_topic_refusal",
	"language_switch",
	"number_readback",
];

const CONFIGS = [
	{ name: "gemini-flash-live", model: "gemini-3.1-flash" },
	{ name: "opal-hosted-tts", model: "deepslate-opal" },
	{ name: "nova-sonic", model: "nova-2-sonic" },
	{ name: "gpt-realtime", model: "gpt-realtime-2.1" },
];

function hashOf(i: number): string {
	return String(i + 1).padStart(64, "0");
}

/** Deterministic pseudo-variation so the grids show a real gradient. */
function vary(a: number, b: number, span: number, base: number): number {
	return base + (((a * 7 + b * 13) % span) / span) * base * 0.9;
}

function cellMetrics(c: number, g: number): RunConfigMetrics {
	const total = 3;
	const passed = (c * 5 + g * 3) % 4 === 0 ? 1 : (c + g) % 3 === 0 ? 2 : 3;
	const assertTotal = 5;
	const judgeTotal = 3;
	return makeRunConfigMetrics({
		pass: { passed: Math.min(passed, total), total },
		assertions: { passed: assertTotal - ((c * 3 + g) % 3), total: assertTotal },
		judges: { passed: (c + g * 2) % (judgeTotal + 1), total: judgeTotal },
		agent_response_ms: {
			avg: Math.round(vary(c, g, 11, 1400)),
			p50: Math.round(vary(c, g, 7, 1300)),
			p95: Math.round(vary(c, g, 5, 2600)),
			n: 6,
		},
		ttft_ms: {
			avg: Math.round(vary(c, g, 9, 420)),
			p50: Math.round(vary(c, g, 6, 400)),
			p95: Math.round(vary(c, g, 4, 900)),
			n: 6,
		},
	});
}

function comparison(): CompareRunConfigsResponse {
	return {
		replay_selection: "latest",
		conversation_scope: "union",
		union_conversations: CONVERSATIONS.length,
		intersection_conversations: CONVERSATIONS.length - 2,
		conversations: CONVERSATIONS.map((name, i) => ({ hash: hashOf(i), name })),
		groups: CONFIGS.map((cfg, g) => ({
			hash: hashOf(100 + g),
			name: cfg.name,
			config: { model: cfg.model, temperature: "0.4" },
			coverage: {
				conversations: CONVERSATIONS.length,
				replays: CONVERSATIONS.length * 3,
				failed_replays: g === 1 ? 2 : 0,
			},
			metrics: cellMetrics(0, g),
			conversations: CONVERSATIONS.map((_, c) => ({
				conversation_hash: hashOf(c),
				replay_id: `r-${g}-${c}`,
				metrics: cellMetrics(c, g),
				// Two configs never ran the last conversation — the gap the grid
				// must render differently from a zero.
			})).filter((_, c) => !(g >= 2 && c === CONVERSATIONS.length - 1)),
		})),
	};
}

const data = comparison();
// The real derivation, not a hand-built map: a fixture that fakes the facet
// split can't show the label degradation it exists to exercise.
const facets = splitConfigFacets(data.groups);

function AllGrids() {
	return (
		<div className="mx-auto max-w-6xl space-y-8 p-8">
			<ConfigChips groups={data.groups} facets={facets} onRemove={() => undefined} />
			{rankedMetricRows().map((row) => (
				<HeatGrid key={row.key} comparison={data} row={row} facets={facets} />
			))}
		</div>
	);
}

const passRow = rankedMetricRows()[0];

/**
 * No names, and a model string long enough that the shared prefix alone
 * overflows a column. This is the state the labels are built for: with the full
 * config summary every header truncated to the same characters, so the grid
 * showed four columns nothing on screen could tell apart.
 */
const unnamed: CompareRunConfigsResponse = {
	...data,
	groups: data.groups.map((group, g) => ({
		...group,
		name: null,
		config: {
			ai_model: "openai_gpt5_6_luna_preview_2026_07_14_high_reasoning",
			region: "eu-central-1",
			temperature: ["0.2", "0.4", "0.7", "1.0"][g] ?? "0.5",
		},
	})),
};
const unnamedFacets = splitConfigFacets(unnamed.groups);

export default {
	"chips + every grid": <AllGrids />,
	"unnamed configs, shared prefix": (
		<div className="mx-auto max-w-6xl space-y-8 p-8">
			<ConfigChips groups={unnamed.groups} facets={unnamedFacets} onRemove={() => undefined} />
			{passRow === undefined ? null : (
				<HeatGrid comparison={unnamed} row={passRow} facets={unnamedFacets} />
			)}
		</div>
	),
	"one grid": (
		<div className="mx-auto max-w-6xl p-8">
			{passRow === undefined ? null : <HeatGrid comparison={data} row={passRow} facets={facets} />}
		</div>
	),
	"chips only": (
		<div className="mx-auto max-w-6xl p-8">
			<ConfigChips groups={data.groups} facets={facets} onRemove={() => undefined} />
		</div>
	),
};
