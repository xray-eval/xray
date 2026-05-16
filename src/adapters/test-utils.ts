import type {
	Agent,
	Conversation,
	ConversationMeta,
	LiveSession,
	ProviderId,
	ToolCall,
	Turn,
	VoiceAgentAdapter,
	Workflow,
	WorkflowEdge,
	WorkflowNode,
} from "./types.ts";

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
	return {
		id: "agent_test_1",
		name: "Test Agent",
		provider: "elevenlabs",
		...overrides,
	};
}

export function makeWorkflowNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
	return {
		id: "node_test_1",
		label: "Test Node",
		...overrides,
	};
}

export function makeWorkflowEdge(overrides: Partial<WorkflowEdge> = {}): WorkflowEdge {
	return {
		id: "edge_test_1",
		from: "node_test_1",
		to: "node_test_2",
		...overrides,
	};
}

export function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
	return {
		agentId: "agent_test_1",
		nodes: [makeWorkflowNode()],
		edges: [],
		...overrides,
	};
}

export function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
	return {
		name: "lookup_balance",
		args: { customer_id: "abc" },
		result: { balance: 1247.55, currency: "EUR" },
		latencyMs: 120,
		...overrides,
	};
}

export function makeTurn(overrides: Partial<Turn> = {}): Turn {
	return {
		id: "turn_test_1",
		role: "user",
		text: "hello",
		timestamp: "2026-05-16T10:00:00.000Z",
		...overrides,
	};
}

export function makeConversationMeta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
	return {
		id: "conv_test_1",
		agentId: "agent_test_1",
		startedAt: "2026-05-16T10:00:00.000Z",
		...overrides,
	};
}

export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
	return {
		...makeConversationMeta(),
		turns: [makeTurn()],
		visitedPath: [],
		...overrides,
	};
}

export function makeLiveSession(overrides: Partial<LiveSession> = {}): LiveSession {
	return {
		conversationId: "conv_test_1",
		onTurn: () => () => undefined,
		stop: () => Promise.resolve(),
		...overrides,
	};
}

export function makeFakeAdapter(
	provider: ProviderId = "elevenlabs",
	overrides: Omit<Partial<VoiceAgentAdapter>, "provider"> = {},
): VoiceAgentAdapter {
	return {
		provider,
		listAgents: () => Promise.resolve([makeAgent({ provider })]),
		getWorkflow: () => Promise.resolve(makeWorkflow()),
		listConversations: () => Promise.resolve([makeConversationMeta()]),
		getConversation: () => Promise.resolve(makeConversation()),
		streamLiveConversation: () => Promise.resolve(makeLiveSession()),
		...overrides,
	};
}
