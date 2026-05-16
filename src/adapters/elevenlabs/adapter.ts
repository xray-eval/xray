import { createHttpClient } from "@/http/http.ts";
import type { HttpClient } from "@/http/types.ts";

import { AdapterError } from "../errors/errors.ts";
import type {
	Agent,
	AgentId,
	Conversation,
	ConversationId,
	ConversationMeta,
	LiveSession,
	ProviderId,
	Role,
	ToolCall,
	Turn,
	VoiceAgentAdapter,
	Workflow,
	WorkflowEdge,
	WorkflowNode,
} from "../types.ts";
import { ElevenLabsMissingWorkflowError } from "./errors.ts";
import type {
	ElevenLabsAgentSummary,
	ElevenLabsConversationResponse,
	ElevenLabsConversationSummary,
	ElevenLabsToolCall,
	ElevenLabsToolResult,
	ElevenLabsTranscriptTurn,
	ElevenLabsVisitedAgentRef,
	ElevenLabsWorkflowEdge,
	ElevenLabsWorkflowNode,
} from "./types.ts";
import {
	ElevenLabsAgentDetailSchema,
	ElevenLabsAgentsListResponseSchema,
	ElevenLabsConversationResponseSchema,
	ElevenLabsConversationsListResponseSchema,
} from "./types.ts";

const PROVIDER: ProviderId = "elevenlabs";
const DEFAULT_BASE_URL = "https://api.elevenlabs.io";

export interface ElevenLabsAdapterOptions {
	apiKey: string;
	/** Defaults to `https://api.elevenlabs.io`. */
	baseUrl?: string;
	/**
	 * Override the HTTP client — primarily for testing retry/timeout policy.
	 * In normal use, omit; the adapter constructs its own ky-backed client.
	 */
	http?: HttpClient;
}

export function createElevenLabsAdapter(opts: ElevenLabsAdapterOptions): VoiceAgentAdapter {
	const http =
		opts.http ??
		createHttpClient({
			baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
			headers: { "xi-api-key": opts.apiKey },
		});

	return {
		provider: PROVIDER,

		async listAgents(): Promise<Agent[]> {
			const data = await http.get("/v1/convai/agents", ElevenLabsAgentsListResponseSchema);
			return data.agents.map(toAgent);
		},

		async getWorkflow(agentId: AgentId): Promise<Workflow> {
			const data = await http.get(
				`/v1/convai/agents/${encodeURIComponent(agentId)}`,
				ElevenLabsAgentDetailSchema,
			);
			const workflow = data.conversation_config.workflow;
			if (!workflow) {
				throw new ElevenLabsMissingWorkflowError(agentId);
			}
			return {
				agentId,
				nodes: workflow.nodes.map(toWorkflowNode),
				edges: workflow.edges.map(toWorkflowEdge),
			};
		},

		async listConversations(agentId: AgentId): Promise<ConversationMeta[]> {
			const data = await http.get(
				"/v1/convai/conversations",
				ElevenLabsConversationsListResponseSchema,
				{ searchParams: { agent_id: agentId } },
			);
			return data.conversations.map(toConversationMeta);
		},

		async getConversation(id: ConversationId): Promise<Conversation> {
			const data = await http.get(
				`/v1/convai/conversations/${encodeURIComponent(id)}`,
				ElevenLabsConversationResponseSchema,
			);
			return toConversation(data);
		},

		streamLiveConversation(_agentId: AgentId): Promise<LiveSession> {
			return Promise.reject(
				new AdapterError("streamLiveConversation not yet implemented for elevenlabs"),
			);
		},
	};
}

function toAgent(s: ElevenLabsAgentSummary): Agent {
	return { id: s.agent_id, name: s.name, provider: PROVIDER };
}

function toWorkflowNode(n: ElevenLabsWorkflowNode): WorkflowNode {
	const node: WorkflowNode = {
		id: n.id,
		label: n.label ?? n.id,
	};
	if (n.additional_prompt !== undefined) {
		node.prompt = n.additional_prompt;
	}
	return node;
}

function toWorkflowEdge(e: ElevenLabsWorkflowEdge): WorkflowEdge {
	const edge: WorkflowEdge = { id: e.id, from: e.source, to: e.target };
	if (e.forward_condition.type === "llm") {
		edge.condition = e.forward_condition.condition;
	}
	return edge;
}

function toConversationMeta(c: ElevenLabsConversationSummary): ConversationMeta {
	const meta: ConversationMeta = {
		id: c.conversation_id,
		agentId: c.agent_id,
		startedAt: unixSecsToIso(c.start_time_unix_secs),
	};
	if (c.call_duration_secs !== undefined) {
		meta.durationMs = c.call_duration_secs * 1000;
	}
	return meta;
}

function toConversation(r: ElevenLabsConversationResponse): Conversation {
	const startUnix = r.metadata?.start_time_unix_secs ?? 0;
	const startedAt = unixSecsToIso(startUnix);
	const conversation: Conversation = {
		id: r.conversation_id,
		agentId: r.agent_id,
		startedAt,
		turns: r.transcript.map((t) => toTurn(t, startUnix)),
		visitedPath: (r.visited_agents ?? []).map(toVisitedNodeId),
	};
	if (r.metadata?.call_duration_secs !== undefined) {
		conversation.durationMs = r.metadata.call_duration_secs * 1000;
	}
	return conversation;
}

function toTurn(t: ElevenLabsTranscriptTurn, startUnix: number): Turn {
	const role: Role = t.role;
	const turn: Turn = {
		id: `${role}_${t.time_in_call_secs}`,
		role,
		text: t.message ?? "",
		timestamp: unixSecsToIso(startUnix + t.time_in_call_secs),
	};
	const latencySecs = t.conversation_turn_metrics?.convai_llm_service_ttf_sentence?.elapsed_time;
	if (latencySecs !== undefined) {
		turn.llmLatencyMs = Math.round(latencySecs * 1000);
	}
	const toolCalls = pairToolCallsWithResults(t.tool_calls ?? [], t.tool_results ?? []);
	if (toolCalls.length > 0) {
		turn.toolCalls = toolCalls;
	}
	return turn;
}

function pairToolCallsWithResults(
	calls: ElevenLabsToolCall[],
	results: ElevenLabsToolResult[],
): ToolCall[] {
	return calls.map((call, idx) => {
		const result = results[idx];
		const toolCall: ToolCall = {
			name: call.tool_name,
			args: safeJsonParse(call.params_as_json),
		};
		if (result !== undefined) {
			toolCall.result = result.result_value;
		}
		return toolCall;
	});
}

function safeJsonParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

function toVisitedNodeId(ref: ElevenLabsVisitedAgentRef): string {
	return ref.agent_id;
}

function unixSecsToIso(secs: number): string {
	return new Date(secs * 1000).toISOString();
}
