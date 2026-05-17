export type ProviderId = "elevenlabs" | "vapi" | "retell" | "openai-realtime" | "voiceflow";

export const ALL_PROVIDERS = [
	"elevenlabs",
	"vapi",
	"retell",
	"openai-realtime",
	"voiceflow",
] as const satisfies readonly ProviderId[];

// Adding a ProviderId without extending ALL_PROVIDERS makes this declaration
// fail because the type below resolves to `never`.
const _allProvidersExhaustive: Exclude<ProviderId, (typeof ALL_PROVIDERS)[number]> extends never
	? true
	: never = true;
void _allProvidersExhaustive;

export type AgentId = string;

export interface Agent {
	id: AgentId;
	name: string;
	provider: ProviderId;
}

export type NodeId = string;
export type EdgeId = string;

export interface WorkflowNode {
	id: NodeId;
	label: string;
	/** System / instruction prompt attached to this node, if the provider exposes it. */
	prompt?: string;
}

export interface WorkflowEdge {
	id: EdgeId;
	from: NodeId;
	to: NodeId;
	/** Natural-language routing condition the provider evaluates with an LLM. */
	condition?: string;
}

export interface Workflow {
	agentId: AgentId;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
}

export type ConversationId = string;
export type TurnId = string;

export type Role = "user" | "agent" | "tool" | "system";

export interface ToolCall {
	name: string;
	args: unknown;
	result?: unknown;
	latencyMs?: number;
}

/**
 * One logical step in a conversation: a user utterance, an agent reply, a tool
 * call + return, or a system event. `activeNodeId` / `edgeFiredId` are
 * vestigial graph-routing fields from a deleted workflow-graph view; an
 * adapter that implements `getWorkflow` may still populate them, but no UI
 * consumes them today.
 */
export interface Turn {
	id: TurnId;
	role: Role;
	text: string;
	/** ISO 8601 timestamp. */
	timestamp: string;
	activeNodeId?: NodeId;
	edgeFiredId?: EdgeId;
	edgeReasoning?: string;
	promptSeen?: string;
	toolCalls?: ToolCall[];
	llmLatencyMs?: number;
}

export interface ConversationMeta {
	id: ConversationId;
	agentId: AgentId;
	/** ISO 8601 timestamp of the conversation start. */
	startedAt: string;
	durationMs?: number;
}

export interface Conversation extends ConversationMeta {
	turns: Turn[];
	/** Ordered list of node IDs the conversation actually walked through. */
	visitedPath: NodeId[];
}

/**
 * Handle to a live, in-progress conversation. The adapter owns the SDK and
 * pushes events through `onTurn`; the consumer signals end-of-conversation
 * via `stop()`.
 */
export interface LiveSession {
	conversationId: ConversationId;
	/** Subscribe to streaming turns; returns an unsubscribe function. */
	onTurn(handler: (turn: Turn) => void): () => void;
	/** End the live session and release mic / SDK resources. */
	stop(): Promise<void>;
}

/**
 * Provider-agnostic contract for a voice-agent platform. New providers ship as
 * `src/adapters/<provider>/adapter.ts` implementing this interface.
 */
export interface VoiceAgentAdapter {
	readonly provider: ProviderId;
	listAgents(): Promise<Agent[]>;
	getWorkflow(agentId: AgentId): Promise<Workflow>;
	listConversations(agentId: AgentId): Promise<ConversationMeta[]>;
	getConversation(id: ConversationId): Promise<Conversation>;
	streamLiveConversation(agentId: AgentId): Promise<LiveSession>;
}
