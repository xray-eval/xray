import type {
	ModelUsageResponse,
	ReplayDetailResponse,
	SpanResponse,
	ToolCallResponse,
} from "@/client/api/api.types.ts";

import { registerHappyDom } from "../../test-happy-dom.ts";
import { SpanSelectionProvider, useSpanSelection } from "../span-selection.tsx";
import { SpanDetailAside, SpanDetailPanel } from "./span-detail.tsx";
import type { SpanDetailModel } from "./span-detail.types.ts";
import { describe, expect, it } from "bun:test";

registerHappyDom();
const { act, cleanup, render, screen } = await import("@testing-library/react");
const { afterEach } = await import("bun:test");

afterEach(() => cleanup());

const REPLAY_START = "2026-05-25T10:00:00.000Z";

function span(overrides: Partial<SpanResponse> = {}): SpanResponse {
	return {
		id: 1,
		trace_id: "0af7651916cd43dd8448eb211c80319c",
		span_id: "span-1",
		parent_span_id: null,
		name: "agent_turn",
		vocabulary: "gen_ai",
		started_at: REPLAY_START,
		ended_at: "2026-05-25T10:00:04.300Z",
		attributes_json: '{"gen_ai.operation.name":"chat","gen_ai.usage.input_tokens":1222}',
		...overrides,
	};
}

function model(overrides: Partial<SpanDetailModel> = {}): SpanDetailModel {
	return {
		span: span(),
		durationMs: 4300,
		startOffsetSec: 0,
		endOffsetSec: 4.3,
		parentName: null,
		attributes: {
			kind: "parsed",
			entries: [
				{
					key: "gen_ai.operation.name",
					namespace: "gen_ai",
					leaf: "operation.name",
					value: "chat",
				},
				{
					key: "gen_ai.usage.input_tokens",
					namespace: "gen_ai",
					leaf: "usage.input_tokens",
					value: 1222,
				},
			],
		},
		usage: [],
		toolCalls: [],
		...overrides,
	};
}

const USAGE: ModelUsageResponse = {
	id: 1,
	turn_idx: 0,
	span_id: "span-1",
	provider: "Gemini",
	model: "gemini-3.1-flash-live-preview",
	input_tokens: 1222,
	output_tokens: 111,
	total_tokens: 1333,
	started_at: null,
	ended_at: null,
	latency_ms: 4302,
};

const TOOL_CALL: ToolCallResponse = {
	id: 1,
	turn_idx: 0,
	span_id: "span-1",
	name: "get_current_year",
	args_json: "{}",
	result_json: '{"year":2026}',
	started_at: null,
	ended_at: null,
	latency_ms: 7,
};

describe("SpanDetailPanel", () => {
	it("renders the span identity, vocabulary, and precise duration", () => {
		render(<SpanDetailPanel detail={model()} onClose={() => undefined} />);
		expect(screen.getByText("agent_turn")).toBeTruthy();
		expect(screen.getByText(/GenAI/)).toBeTruthy();
		expect(screen.getByText("4.30s")).toBeTruthy();
	});

	it("surfaces the full attribute bag — keys and type-rendered values", () => {
		render(<SpanDetailPanel detail={model()} onClose={() => undefined} />);
		expect(screen.getByText("operation.name")).toBeTruthy();
		expect(screen.getByText("chat")).toBeTruthy();
		expect(screen.getByText("usage.input_tokens")).toBeTruthy();
		expect(screen.getByText("1222")).toBeTruthy();
	});

	it("type-renders boolean, null, nested-container, and unrecognized attribute values", () => {
		render(
			<SpanDetailPanel
				detail={model({
					attributes: {
						kind: "parsed",
						entries: [
							{ key: "xray.stream", namespace: "xray", leaf: "stream", value: true },
							{ key: "xray.parent_id", namespace: "xray", leaf: "parent_id", value: null },
							{ key: "xray.opts", namespace: "xray", leaf: "opts", value: { region: "us-east" } },
							{ key: "xray.unset", namespace: "xray", leaf: "unset", value: undefined },
						],
					},
				})}
				onClose={() => undefined}
			/>,
		);
		expect(screen.getByText("true")).toBeTruthy();
		expect(screen.getByText("null")).toBeTruthy();
		expect(screen.getByText(/region/)).toBeTruthy();
		expect(screen.getByText("—")).toBeTruthy();
	});

	it("renders linked model usage with provider, model, and latency", () => {
		render(<SpanDetailPanel detail={model({ usage: [USAGE] })} onClose={() => undefined} />);
		expect(screen.getByText("gemini-3.1-flash-live-preview")).toBeTruthy();
		expect(screen.getByText(/4302/)).toBeTruthy();
	});

	it("renders linked tool calls with name and result", () => {
		render(
			<SpanDetailPanel detail={model({ toolCalls: [TOOL_CALL] })} onClose={() => undefined} />,
		);
		expect(screen.getByText("get_current_year")).toBeTruthy();
		expect(screen.getByText("2026")).toBeTruthy();
	});

	it("falls back to raw text when the attribute bag isn't a JSON object", () => {
		render(
			<SpanDetailPanel
				detail={model({ attributes: { kind: "raw", raw: "not-json-bag" } })}
				onClose={() => undefined}
			/>,
		);
		expect(screen.getByText("not-json-bag")).toBeTruthy();
	});

	it("calls onClose when the close button is clicked", () => {
		let closed = 0;
		render(<SpanDetailPanel detail={model()} onClose={() => (closed += 1)} />);
		act(() => screen.getByLabelText(/close span detail/i).click());
		expect(closed).toBe(1);
	});
});

function replay(overrides: Partial<ReplayDetailResponse> = {}): ReplayDetailResponse {
	return {
		id: "r1",
		conversation_hash: "hash",
		lifecycle_state: "completed",
		analysis_step: null,
		failure_reason: null,
		started_at: REPLAY_START,
		finished_at: null,
		audio_path: null,
		job_id: null,
		run_config: null,
		turns: [],
		speech_segments: [],
		tool_calls: [TOOL_CALL],
		model_usage: [USAGE],
		spans: [span()],
		...overrides,
	};
}

function AsideHarness({ replay: r }: { replay: ReplayDetailResponse }) {
	const { select } = useSpanSelection();
	return (
		<>
			<button type="button" onClick={() => select("span-1")}>
				pick
			</button>
			<SpanDetailAside replay={r} />
		</>
	);
}

describe("SpanDetailAside", () => {
	it("renders nothing when the replay has no spans", () => {
		render(
			<SpanSelectionProvider>
				<SpanDetailAside replay={replay({ spans: [] })} />
			</SpanSelectionProvider>,
		);
		expect(screen.queryByText(/select a span/i)).toBeNull();
		expect(screen.queryByText("agent_turn")).toBeNull();
	});

	it("prompts the user to select a span before one is chosen", () => {
		render(
			<SpanSelectionProvider>
				<SpanDetailAside replay={replay()} />
			</SpanSelectionProvider>,
		);
		expect(screen.getByText(/select a span/i)).toBeTruthy();
	});

	it("resolves and shows the detail once a span is selected", () => {
		render(
			<SpanSelectionProvider>
				<AsideHarness replay={replay()} />
			</SpanSelectionProvider>,
		);
		expect(screen.queryByText("agent_turn")).toBeNull();
		act(() => screen.getByText("pick").click());
		expect(screen.getByText("agent_turn")).toBeTruthy();
		expect(screen.getByText("get_current_year")).toBeTruthy();
	});
});
