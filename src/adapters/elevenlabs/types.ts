import * as v from "valibot";

// `v.object` strips unknown keys — model only the fields we consume, and let
// the schema check (not the static type) gate runtime data.

export const ElevenLabsAgentSummarySchema = v.object({
	agent_id: v.string(),
	name: v.string(),
	tags: v.optional(v.array(v.string())),
	created_at_unix_secs: v.optional(v.number()),
	last_call_time_unix_secs: v.optional(v.nullable(v.number())),
	archived: v.optional(v.boolean()),
});
export type ElevenLabsAgentSummary = v.InferOutput<typeof ElevenLabsAgentSummarySchema>;

export const ElevenLabsAgentsListResponseSchema = v.object({
	agents: v.array(ElevenLabsAgentSummarySchema),
	next_cursor: v.nullable(v.string()),
	has_more: v.boolean(),
});
export type ElevenLabsAgentsListResponse = v.InferOutput<typeof ElevenLabsAgentsListResponseSchema>;

export const ElevenLabsForwardConditionSchema = v.variant("type", [
	v.object({ type: v.literal("unconditional") }),
	v.object({ type: v.literal("llm"), condition: v.string() }),
	v.object({ type: v.literal("expression"), expression: v.string() }),
]);
export type ElevenLabsForwardCondition = v.InferOutput<typeof ElevenLabsForwardConditionSchema>;

export const ElevenLabsWorkflowNodeSchema = v.object({
	id: v.string(),
	type: v.picklist([
		"start",
		"subagent",
		"override_agent",
		"end",
		"agent_transfer",
		"dispatch_tool",
	]),
	label: v.optional(v.string()),
	additional_prompt: v.optional(v.string()),
});
export type ElevenLabsWorkflowNode = v.InferOutput<typeof ElevenLabsWorkflowNodeSchema>;

export const ElevenLabsWorkflowEdgeSchema = v.object({
	id: v.string(),
	source: v.string(),
	target: v.string(),
	forward_condition: ElevenLabsForwardConditionSchema,
});
export type ElevenLabsWorkflowEdge = v.InferOutput<typeof ElevenLabsWorkflowEdgeSchema>;

export const ElevenLabsAgentDetailSchema = v.object({
	agent_id: v.string(),
	name: v.string(),
	conversation_config: v.object({
		workflow: v.optional(
			v.object({
				nodes: v.array(ElevenLabsWorkflowNodeSchema),
				edges: v.array(ElevenLabsWorkflowEdgeSchema),
			}),
		),
	}),
});
export type ElevenLabsAgentDetail = v.InferOutput<typeof ElevenLabsAgentDetailSchema>;

export const ElevenLabsConversationSummarySchema = v.object({
	conversation_id: v.string(),
	agent_id: v.string(),
	start_time_unix_secs: v.number(),
	call_duration_secs: v.optional(v.number()),
});
export type ElevenLabsConversationSummary = v.InferOutput<
	typeof ElevenLabsConversationSummarySchema
>;

export const ElevenLabsConversationsListResponseSchema = v.object({
	conversations: v.array(ElevenLabsConversationSummarySchema),
	next_cursor: v.nullable(v.string()),
	has_more: v.boolean(),
});
export type ElevenLabsConversationsListResponse = v.InferOutput<
	typeof ElevenLabsConversationsListResponseSchema
>;

export const ElevenLabsToolCallSchema = v.object({
	tool_name: v.string(),
	params_as_json: v.string(),
});
export type ElevenLabsToolCall = v.InferOutput<typeof ElevenLabsToolCallSchema>;

export const ElevenLabsToolResultSchema = v.object({
	tool_name: v.string(),
	result_value: v.unknown(),
});
export type ElevenLabsToolResult = v.InferOutput<typeof ElevenLabsToolResultSchema>;

export const ElevenLabsTurnMetricsSchema = v.object({
	convai_llm_service_ttf_sentence: v.optional(v.object({ elapsed_time: v.optional(v.number()) })),
});
export type ElevenLabsTurnMetrics = v.InferOutput<typeof ElevenLabsTurnMetricsSchema>;

export const ElevenLabsTranscriptTurnSchema = v.object({
	role: v.picklist(["user", "agent"]),
	message: v.nullable(v.string()),
	time_in_call_secs: v.number(),
	tool_calls: v.optional(v.array(ElevenLabsToolCallSchema)),
	tool_results: v.optional(v.array(ElevenLabsToolResultSchema)),
	conversation_turn_metrics: v.optional(ElevenLabsTurnMetricsSchema),
});
export type ElevenLabsTranscriptTurn = v.InferOutput<typeof ElevenLabsTranscriptTurnSchema>;

export const ElevenLabsVisitedAgentRefSchema = v.object({
	agent_id: v.string(),
	branch_id: v.optional(v.string()),
});
export type ElevenLabsVisitedAgentRef = v.InferOutput<typeof ElevenLabsVisitedAgentRefSchema>;

export const ElevenLabsConversationResponseSchema = v.object({
	conversation_id: v.string(),
	agent_id: v.string(),
	agent_name: v.optional(v.string()),
	status: v.picklist(["initiated", "in-progress", "processing", "done", "failed"]),
	metadata: v.optional(
		v.object({
			start_time_unix_secs: v.optional(v.number()),
			call_duration_secs: v.optional(v.number()),
		}),
	),
	visited_agents: v.optional(v.array(ElevenLabsVisitedAgentRefSchema)),
	transcript: v.array(ElevenLabsTranscriptTurnSchema),
});
export type ElevenLabsConversationResponse = v.InferOutput<
	typeof ElevenLabsConversationResponseSchema
>;
