import { useState } from "react";

import type { RunConfigSummary } from "@/client/api/api.types.ts";

import { MAX_COMPARE, toggleSelection } from "./compare-selection.ts";
import { splitConfigFacets } from "./config-facets.ts";
import { ConfigPicker } from "./config-picker.tsx";

const MODELS = ["openai_gpt5_6_luna", "openai_gpt5_6_terra"];
const CONVERSATIONS = [
	"barge_in_recovery",
	"refund_flow",
	"tool_heavy_dispatch",
	"silence_handling",
	"multi_intent_booking",
	"accent_stress",
	"long_context_recall",
	"interruption_storm",
];

function summary(over: Partial<RunConfigSummary> & { hash: string }): RunConfigSummary {
	return {
		name: null,
		config: { model: "gpt-5" },
		created_at: "2026-07-01T00:00:00.000Z",
		last_run_at: "2026-07-01T00:00:00.000Z",
		coverage: { conversations: 1, replays: 1, failed_replays: 0 },
		...over,
	};
}

/**
 * The shape that broke the page: two models across eight conversations, most of
 * them never run. Every label shared a long prefix, so all 47 rows rendered as
 * the same truncated string.
 */
function manyConfigs(): RunConfigSummary[] {
	const items: RunConfigSummary[] = [];
	for (const model of MODELS) {
		for (const conversation of CONVERSATIONS) {
			for (const temperature of ["0.2", "0.7", "1.0"]) {
				const idx = items.length;
				const ran = idx % 4 === 0;
				items.push(
					summary({
						hash: String(idx + 1).padStart(64, "0"),
						config: { ai_model: model, conversation, temperature },
						last_run_at: ran ? "2026-07-01T00:00:00.000Z" : null,
						coverage: ran
							? { conversations: 1, replays: 1 + (idx % 3), failed_replays: idx % 5 === 0 ? 1 : 0 }
							: { conversations: 0, replays: 0, failed_replays: 0 },
					}),
				);
			}
		}
	}
	return items;
}

/** Picker with live selection state, so the at-the-cap and never-run states are reachable. */
function Harness({ items, initial }: { items: RunConfigSummary[]; initial: string[] }) {
	const [selected, setSelected] = useState<readonly string[]>(initial);
	const facets = splitConfigFacets(items);
	// The real selection rule, not a copy of it — a fixture whose job is to show
	// the at-the-cap state has to use the same cap the app does.
	function toggle(hash: string) {
		setSelected((current) => toggleSelection(current, hash));
	}

	return (
		<div className="mx-auto max-w-5xl space-y-3 p-8">
			<ConfigPicker items={items} facets={facets} selected={selected} onToggle={toggle} />
		</div>
	);
}

const many = manyConfigs();
const few = [
	summary({
		hash: "a".repeat(64),
		name: "baseline",
		config: { model: "gpt-5", temperature: "0.2" },
	}),
	summary({
		hash: "b".repeat(64),
		name: "fast-follow",
		config: { model: "gpt-5", temperature: "0.9" },
		coverage: { conversations: 3, replays: 7, failed_replays: 2 },
	}),
	summary({
		hash: "c".repeat(64),
		config: { model: "claude-opus", temperature: "0.2" },
		coverage: { conversations: 2, replays: 4, failed_replays: 0 },
	}),
];

export default {
	"47 configs": <Harness items={many} initial={[many[0]?.hash ?? "", many[4]?.hash ?? ""]} />,
	"a few, named": <Harness items={few} initial={[few[0]?.hash ?? "", few[1]?.hash ?? ""]} />,
	"at the cap": <Harness items={many} initial={many.slice(0, MAX_COMPARE).map((i) => i.hash)} />,
	"all never run": (
		<Harness
			items={many.map((item) => ({
				...item,
				last_run_at: null,
				coverage: { conversations: 0, replays: 0, failed_replays: 0 },
			}))}
			initial={[]}
		/>
	),
};
