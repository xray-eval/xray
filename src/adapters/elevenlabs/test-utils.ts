import type {
	ElevenLabsAgentDetail,
	ElevenLabsAgentSummary,
	ElevenLabsConversationResponse,
	ElevenLabsConversationSummary,
	ElevenLabsToolCall,
	ElevenLabsToolResult,
	ElevenLabsTranscriptTurn,
	ElevenLabsWorkflowEdge,
	ElevenLabsWorkflowNode,
} from "./types.ts";

export function makeElevenLabsAgent(
	overrides: Partial<ElevenLabsAgentSummary> = {},
): ElevenLabsAgentSummary {
	return {
		agent_id: "agent_1",
		name: "Test Agent",
		tags: [],
		created_at_unix_secs: 1700000000,
		archived: false,
		...overrides,
	};
}

export function makeElevenLabsWorkflowNode(
	overrides: Partial<ElevenLabsWorkflowNode> = {},
): ElevenLabsWorkflowNode {
	return {
		id: "node_start",
		type: "start",
		label: "Start",
		...overrides,
	};
}

export function makeElevenLabsWorkflowEdge(
	overrides: Partial<ElevenLabsWorkflowEdge> = {},
): ElevenLabsWorkflowEdge {
	return {
		id: "edge_1",
		source: "node_start",
		target: "node_end",
		forward_condition: { type: "unconditional" },
		...overrides,
	};
}

export function makeElevenLabsAgentDetail(
	overrides: Partial<ElevenLabsAgentDetail> = {},
): ElevenLabsAgentDetail {
	return {
		agent_id: "agent_1",
		name: "Test Agent",
		conversation_config: {
			workflow: {
				nodes: [makeElevenLabsWorkflowNode()],
				edges: [],
			},
		},
		...overrides,
	};
}

export function makeElevenLabsToolCall(
	overrides: Partial<ElevenLabsToolCall> = {},
): ElevenLabsToolCall {
	return {
		tool_name: "lookup_balance",
		params_as_json: '{"customer_id":"abc"}',
		...overrides,
	};
}

export function makeElevenLabsToolResult(
	overrides: Partial<ElevenLabsToolResult> = {},
): ElevenLabsToolResult {
	return {
		tool_name: "lookup_balance",
		result_value: { balance: 1247.55, currency: "EUR" },
		...overrides,
	};
}

export function makeElevenLabsTranscriptTurn(
	overrides: Partial<ElevenLabsTranscriptTurn> = {},
): ElevenLabsTranscriptTurn {
	return {
		role: "user",
		message: "hello",
		time_in_call_secs: 0,
		...overrides,
	};
}

export function makeElevenLabsConversationSummary(
	overrides: Partial<ElevenLabsConversationSummary> = {},
): ElevenLabsConversationSummary {
	return {
		conversation_id: "conv_1",
		agent_id: "agent_1",
		start_time_unix_secs: 1700000000,
		call_duration_secs: 42,
		...overrides,
	};
}

export function makeElevenLabsConversationResponse(
	overrides: Partial<ElevenLabsConversationResponse> = {},
): ElevenLabsConversationResponse {
	// visited_agents is omitted from defaults so tests can assert the
	// field-absent fallback without violating exactOptionalPropertyTypes.
	return {
		conversation_id: "conv_1",
		agent_id: "agent_1",
		agent_name: "Test Agent",
		status: "done",
		metadata: { start_time_unix_secs: 1700000000, call_duration_secs: 42 },
		transcript: [makeElevenLabsTranscriptTurn()],
		...overrides,
	};
}
