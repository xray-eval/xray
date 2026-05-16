import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";

import { HttpRequestFailedError, HttpResponseShapeError } from "@/http/errors.ts";
import { server } from "@/test-server.ts";

import { AdapterError } from "../errors/errors.ts";
import { createElevenLabsAdapter } from "./adapter.ts";
import { ElevenLabsMissingWorkflowError } from "./errors.ts";
import {
	makeElevenLabsAgent,
	makeElevenLabsAgentDetail,
	makeElevenLabsConversationResponse,
	makeElevenLabsConversationSummary,
	makeElevenLabsToolCall,
	makeElevenLabsToolResult,
	makeElevenLabsTranscriptTurn,
	makeElevenLabsWorkflowEdge,
	makeElevenLabsWorkflowNode,
} from "./test-utils.ts";

const API_KEY = "test-key";
const BASE_URL = "https://api.elevenlabs.io";

function makeAdapter() {
	return createElevenLabsAdapter({ apiKey: API_KEY });
}

describe("createElevenLabsAdapter", () => {
	it("identifies itself as the elevenlabs provider", () => {
		expect(makeAdapter().provider).toBe("elevenlabs");
	});

	describe("listAgents", () => {
		it("calls GET /v1/convai/agents with the xi-api-key header", async () => {
			const seen = vi.fn();
			server.use(
				http.get(`${BASE_URL}/v1/convai/agents`, ({ request }) => {
					seen(request.headers.get("xi-api-key"));
					return HttpResponse.json({ agents: [], next_cursor: null, has_more: false });
				}),
			);

			await makeAdapter().listAgents();

			expect(seen).toHaveBeenCalledOnce();
			expect(seen).toHaveBeenCalledWith(API_KEY);
		});

		it("maps the API response to provider-agnostic Agent[]", async () => {
			server.use(
				http.get(`${BASE_URL}/v1/convai/agents`, () =>
					HttpResponse.json({
						agents: [
							makeElevenLabsAgent({ agent_id: "agent_a", name: "Alpha" }),
							makeElevenLabsAgent({ agent_id: "agent_b", name: "Beta" }),
						],
						next_cursor: null,
						has_more: false,
					}),
				),
			);

			const agents = await makeAdapter().listAgents();

			expect(agents).toEqual([
				{ id: "agent_a", name: "Alpha", provider: "elevenlabs" },
				{ id: "agent_b", name: "Beta", provider: "elevenlabs" },
			]);
		});

		it("throws HttpRequestFailedError on non-2xx with status and body", async () => {
			server.use(
				http.get(`${BASE_URL}/v1/convai/agents`, () =>
					HttpResponse.json({ detail: "Unauthorized" }, { status: 401 }),
				),
			);

			const promise = makeAdapter().listAgents();
			await expect(promise).rejects.toBeInstanceOf(HttpRequestFailedError);
			await expect(promise).rejects.toMatchObject({ status: 401 });
		});

		it("throws HttpResponseShapeError when the payload fails schema validation", async () => {
			server.use(
				http.get(`${BASE_URL}/v1/convai/agents`, () => HttpResponse.json({ unexpected: "shape" })),
			);

			const promise = makeAdapter().listAgents();
			await expect(promise).rejects.toBeInstanceOf(HttpResponseShapeError);
		});
	});

	describe("getWorkflow", () => {
		it("calls GET /v1/convai/agents/{id} and maps nodes/edges", async () => {
			const seen = vi.fn();
			server.use(
				http.get(`${BASE_URL}/v1/convai/agents/agent_1`, ({ request }) => {
					seen(request.url);
					return HttpResponse.json(
						makeElevenLabsAgentDetail({
							conversation_config: {
								workflow: {
									nodes: [
										makeElevenLabsWorkflowNode({ id: "n1", label: "Start", type: "start" }),
										makeElevenLabsWorkflowNode({
											id: "n2",
											label: "Router",
											type: "subagent",
											additional_prompt: "You route customer requests.",
										}),
									],
									edges: [
										makeElevenLabsWorkflowEdge({
											id: "e1",
											source: "n1",
											target: "n2",
											forward_condition: { type: "unconditional" },
										}),
									],
								},
							},
						}),
					);
				}),
			);

			const workflow = await makeAdapter().getWorkflow("agent_1");

			expect(seen).toHaveBeenCalledOnce();
			expect(workflow).toEqual({
				agentId: "agent_1",
				nodes: [
					{ id: "n1", label: "Start" },
					{ id: "n2", label: "Router", prompt: "You route customer requests." },
				],
				edges: [{ id: "e1", from: "n1", to: "n2" }],
			});
		});

		it("surfaces the LLM forward-condition string on the mapped edge", async () => {
			server.use(
				http.get(`${BASE_URL}/v1/convai/agents/agent_1`, () =>
					HttpResponse.json(
						makeElevenLabsAgentDetail({
							conversation_config: {
								workflow: {
									nodes: [makeElevenLabsWorkflowNode()],
									edges: [
										makeElevenLabsWorkflowEdge({
											id: "e_llm",
											forward_condition: { type: "llm", condition: "user asked about money" },
										}),
									],
								},
							},
						}),
					),
				),
			);

			const workflow = await makeAdapter().getWorkflow("agent_1");

			expect(workflow.edges[0]).toMatchObject({
				id: "e_llm",
				condition: "user asked about money",
			});
		});

		it("throws ElevenLabsMissingWorkflowError when the agent has no workflow", async () => {
			server.use(
				http.get(`${BASE_URL}/v1/convai/agents/agent_1`, () =>
					HttpResponse.json(makeElevenLabsAgentDetail({ conversation_config: {} })),
				),
			);

			await expect(makeAdapter().getWorkflow("agent_1")).rejects.toBeInstanceOf(
				ElevenLabsMissingWorkflowError,
			);
		});
	});

	describe("listConversations", () => {
		it("calls GET /v1/convai/conversations?agent_id=... and maps to ConversationMeta[]", async () => {
			const seen = vi.fn();
			server.use(
				http.get(`${BASE_URL}/v1/convai/conversations`, ({ request }) => {
					seen(new URL(request.url).searchParams.get("agent_id"));
					return HttpResponse.json({
						conversations: [
							makeElevenLabsConversationSummary({
								conversation_id: "conv_a",
								agent_id: "agent_1",
								start_time_unix_secs: 1_710_000_000,
								call_duration_secs: 30,
							}),
						],
						next_cursor: null,
						has_more: false,
					});
				}),
			);

			const conversations = await makeAdapter().listConversations("agent_1");

			expect(seen).toHaveBeenCalledWith("agent_1");
			expect(conversations).toEqual([
				{
					id: "conv_a",
					agentId: "agent_1",
					startedAt: new Date(1_710_000_000 * 1000).toISOString(),
					durationMs: 30_000,
				},
			]);
		});

		it("url-encodes the agent id query parameter", async () => {
			const seen = vi.fn();
			server.use(
				http.get(`${BASE_URL}/v1/convai/conversations`, ({ request }) => {
					seen(new URL(request.url).search);
					return HttpResponse.json({ conversations: [], next_cursor: null, has_more: false });
				}),
			);

			await makeAdapter().listConversations("weird/agent");

			expect(seen).toHaveBeenCalledWith("?agent_id=weird%2Fagent");
		});
	});

	describe("getConversation", () => {
		it("maps transcript turns into provider-agnostic Turn[] with absolute timestamps", async () => {
			const startUnix = 1_710_000_000;
			server.use(
				http.get(`${BASE_URL}/v1/convai/conversations/conv_1`, () =>
					HttpResponse.json(
						makeElevenLabsConversationResponse({
							metadata: { start_time_unix_secs: startUnix, call_duration_secs: 5 },
							transcript: [
								makeElevenLabsTranscriptTurn({
									role: "user",
									message: "hi",
									time_in_call_secs: 0,
								}),
								makeElevenLabsTranscriptTurn({
									role: "agent",
									message: "hello there",
									time_in_call_secs: 2,
									conversation_turn_metrics: {
										convai_llm_service_ttf_sentence: { elapsed_time: 0.412 },
									},
								}),
							],
						}),
					),
				),
			);

			const conversation = await makeAdapter().getConversation("conv_1");

			expect(conversation.id).toBe("conv_1");
			expect(conversation.agentId).toBe("agent_1");
			expect(conversation.startedAt).toBe(new Date(startUnix * 1000).toISOString());
			expect(conversation.durationMs).toBe(5_000);
			expect(conversation.turns).toHaveLength(2);
			expect(conversation.turns[0]).toMatchObject({
				role: "user",
				text: "hi",
				timestamp: new Date(startUnix * 1000).toISOString(),
			});
			expect(conversation.turns[1]).toMatchObject({
				role: "agent",
				text: "hello there",
				timestamp: new Date((startUnix + 2) * 1000).toISOString(),
				llmLatencyMs: 412,
			});
		});

		it("derives visitedPath from visited_agents preserving order", async () => {
			server.use(
				http.get(`${BASE_URL}/v1/convai/conversations/conv_1`, () =>
					HttpResponse.json(
						makeElevenLabsConversationResponse({
							visited_agents: [
								{ agent_id: "node_start" },
								{ agent_id: "node_router" },
								{ agent_id: "node_balance" },
							],
						}),
					),
				),
			);

			const conversation = await makeAdapter().getConversation("conv_1");

			expect(conversation.visitedPath).toEqual(["node_start", "node_router", "node_balance"]);
		});

		it("pairs tool_calls with matching tool_results into Turn.toolCalls", async () => {
			server.use(
				http.get(`${BASE_URL}/v1/convai/conversations/conv_1`, () =>
					HttpResponse.json(
						makeElevenLabsConversationResponse({
							transcript: [
								makeElevenLabsTranscriptTurn({
									role: "agent",
									message: "let me check",
									tool_calls: [
										makeElevenLabsToolCall({
											tool_name: "lookup_balance",
											params_as_json: '{"customer_id":"abc"}',
										}),
									],
									tool_results: [
										makeElevenLabsToolResult({
											tool_name: "lookup_balance",
											result_value: { balance: 1247.55, currency: "EUR" },
										}),
									],
								}),
							],
						}),
					),
				),
			);

			const conversation = await makeAdapter().getConversation("conv_1");

			expect(conversation.turns[0]?.toolCalls).toEqual([
				{
					name: "lookup_balance",
					args: { customer_id: "abc" },
					result: { balance: 1247.55, currency: "EUR" },
				},
			]);
		});

		it("falls back to an empty visitedPath when the field is absent", async () => {
			server.use(
				http.get(`${BASE_URL}/v1/convai/conversations/conv_1`, () =>
					HttpResponse.json(makeElevenLabsConversationResponse()),
				),
			);

			const conversation = await makeAdapter().getConversation("conv_1");
			expect(conversation.visitedPath).toEqual([]);
		});
	});

	describe("streamLiveConversation", () => {
		it("rejects with AdapterError — live mode lands in a follow-up slice", async () => {
			await expect(makeAdapter().streamLiveConversation("agent_1")).rejects.toBeInstanceOf(
				AdapterError,
			);
		});
	});
});
