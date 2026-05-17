// FOR XRAY CONTRIBUTORS ONLY — not a feature of xray itself.
//
// Throwaway OpenAI-backed HTTP server used by contributors hacking on this
// repo to verify the agent-replay loop end-to-end when changing replay-
// related code (src/server/replays/*, src/client/replays/*). Real xray users
// already have their own agent loop — that's what they point Replay at —
// they have no reason to run this script.
//
// What it does:
//   1. Listens on :4000 (overridable via --port / PORT).
//   2. Accepts POST /replay with xray's webhook payload.
//   3. Maps history into chat-completions messages (user→user, agent→assistant).
//   4. Builds OpenAI tool definitions from `recordedToolResults` — one per
//      tool the original agent called, with the recorded example pasted into
//      the description so the model knows what the tool does without a real
//      schema. Lets the model call tools through a multi-round loop; we
//      satisfy each call by looking up the recorded result by tool name and
//      feeding it back.
//   5. Returns the final `agentText` plus every tool the model called.
//
// Usage (sibling compose service — the intended path):
//   pnpm dev:webhook       # brings up xray-dev AND agent-webhook
//   # then in the UI, click Replay and use http://agent-webhook:4000/replay
//
// Usage (bare on host, e.g. when running xray with `bun src/server/main.ts`):
//   OPENAI_API_KEY=sk-... bun scripts/agent-webhook.ts
//   # then use http://localhost:4000/replay
//
// Configuration (env vars, all optional except OPENAI_API_KEY):
//   OPENAI_API_KEY        required
//   OPENAI_MODEL          default "gpt-4o-mini"
//   AGENT_SYSTEM_PROMPT   default neutral baseline; override to match the
//                         voice/text/persona of the source session you're
//                         debugging. THIS IS THE BIGGEST KNOB — a bad
//                         default here manufactures diffs that aren't bugs.
//   PORT                  default 4000
// CLI flags (--port, --model, --system) override the env vars.
//
// Why no openai SDK: keeps this contributor-only script out of package.json
// (and out of the 7-day supply-chain cooldown). Raw fetch is enough.

import * as v from "valibot";

// Env codec — per boundary-validation.md, env vars get parsed once at startup
// rather than read ad-hoc as untyped index lookups. Failing here gives the
// operator one clear error instead of cryptic `undefined` symptoms later.
const EnvSchema = v.object({
	OPENAI_API_KEY: v.pipe(v.string(), v.minLength(1, "OPENAI_API_KEY is required")),
	OPENAI_MODEL: v.optional(v.string()),
	AGENT_SYSTEM_PROMPT: v.optional(v.string()),
	PORT: v.optional(v.string()),
});

const envResult = v.safeParse(EnvSchema, process.env);
if (!envResult.success) {
	console.error("Environment validation failed:");
	for (const issue of envResult.issues) {
		const path = issue.path?.map((p) => String(p.key)).join(".") ?? "(root)";
		console.error(`  ${path}: ${issue.message}`);
	}
	process.exit(1);
}
const ENV = envResult.output;

interface ScriptArgs {
	port?: string;
	model?: string;
	system?: string;
}

const ARGS: ScriptArgs = parseArgs(process.argv.slice(2));
const PORT = Number(ARGS.port ?? ENV.PORT ?? "4000");
const MODEL = ARGS.model ?? ENV.OPENAI_MODEL ?? "gpt-4o-mini";
// Neutral baseline — no length/format/voice constraints. Anything more
// opinionated would bias the diff (a "two short sentences" rule manufactures
// length divergence against a source session whose agent gave long answers).
// Override via AGENT_SYSTEM_PROMPT or --system when debugging a specific
// agent style.
const SYSTEM_PROMPT =
	ARGS.system ??
	ENV.AGENT_SYSTEM_PROMPT ??
	"You are a helpful assistant. Use the conversation history for context.";

// Bound the tool-calling loop. The OpenAI/recorded-tools combo can occasionally
// loop ("got the wrong answer, let me try again" → same recorded result →
// repeat). A small cap catches that; 5 is plenty for realistic agents.
const MAX_TOOL_ROUNDS = 5;

// Schema is re-derived from xray's WebhookRequestSchema (not imported) so a
// contract change breaks loudly here at the boundary instead of silently.
const MAX_HISTORY = 1024;
const MAX_TURN_TEXT = 50_000;
const MAX_TOOL_RESULTS = 256;

const WebhookRequestSchema = v.object({
	sessionId: v.string(),
	turnIdx: v.number(),
	userText: v.pipe(v.string(), v.maxLength(MAX_TURN_TEXT)),
	history: v.pipe(
		v.array(
			v.object({
				role: v.string(),
				text: v.pipe(v.string(), v.maxLength(MAX_TURN_TEXT)),
			}),
		),
		v.maxLength(MAX_HISTORY),
	),
	recordedToolResults: v.pipe(
		v.array(v.object({ name: v.string(), args: v.unknown(), result: v.unknown() })),
		v.maxLength(MAX_TOOL_RESULTS),
	),
});
type WebhookRequest = v.InferOutput<typeof WebhookRequestSchema>;
type RecordedToolResult = WebhookRequest["recordedToolResults"][number];

// OpenAI assistant-message shape we care about. `content` is null when the
// message is purely tool calls; `tool_calls` is absent on plain-text replies.
const AssistantToolCallSchema = v.object({
	id: v.string(),
	type: v.literal("function"),
	function: v.object({ name: v.string(), arguments: v.string() }),
});
const OpenAIChatResponseSchema = v.object({
	choices: v.pipe(
		v.array(
			v.object({
				message: v.object({
					content: v.nullable(v.string()),
					tool_calls: v.optional(v.array(AssistantToolCallSchema)),
				}),
			}),
		),
		v.minLength(1),
	),
});
type AssistantToolCall = v.InferOutput<typeof AssistantToolCallSchema>;

type OpenAIMessage =
	| { role: "system" | "user"; content: string }
	| { role: "assistant"; content: string | null; tool_calls?: AssistantToolCall[] }
	| { role: "tool"; tool_call_id: string; content: string };

interface OpenAITool {
	type: "function";
	function: {
		name: string;
		description: string;
		// Empty-object schema = "any object, any keys". Deliberately permissive
		// because we don't have a real schema — only one observed example call.
		parameters: { type: "object"; properties: Record<string, never> };
	};
}

function buildMessages(req: WebhookRequest): OpenAIMessage[] {
	const messages: OpenAIMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
	for (const turn of req.history) {
		if (turn.role === "user") messages.push({ role: "user", content: turn.text });
		else if (turn.role === "agent") messages.push({ role: "assistant", content: turn.text });
		// "tool" and "system" history entries are skipped: mapping them onto
		// OpenAI tool messages needs tool_call_id bookkeeping we don't have, and
		// re-injecting source system prompts would conflict with ours.
	}
	messages.push({ role: "user", content: req.userText });
	return messages;
}

function buildTools(recorded: readonly RecordedToolResult[]): OpenAITool[] {
	// Dedupe by name — multiple recorded calls of the same tool collapse to one
	// definition. The example shows the args shape from the first observed call;
	// the recorded *result* is deliberately NOT in the description so the model
	// can't read the answer out of the prompt and skip the tool call. The model
	// only gets ground-truth data by actually calling the tool, which is what
	// we want the debugger to test.
	const byName = new Map<string, RecordedToolResult>();
	for (const r of recorded) {
		if (!byName.has(r.name)) byName.set(r.name, r);
	}
	return [...byName.values()].map((r) => ({
		type: "function" as const,
		function: {
			name: r.name,
			description: `Tool the original agent had access to. Example call: ${r.name}(${JSON.stringify(r.args)})`,
			parameters: { type: "object" as const, properties: {} },
		},
	}));
}

function lookupRecordedResult(name: string, recorded: readonly RecordedToolResult[]): unknown {
	// Name-only match. Strict (name + exact args) fails constantly because the
	// model rarely guesses identical args, and it would push the loop toward
	// MAX_TOOL_ROUNDS for no real signal. Name-only is honest: "you would have
	// called this tool — here's what it returned last time."
	const hit = recorded.find((r) => r.name === name);
	if (hit !== undefined) return hit.result;
	return { error: `tool not available — the original agent never called "${name}"` };
}

interface CallResult {
	agentText: string;
	toolCalls: Array<{ name: string; args: unknown }>;
}

async function callOpenAI(
	initialMessages: OpenAIMessage[],
	recorded: readonly RecordedToolResult[],
): Promise<CallResult> {
	const tools = buildTools(recorded);
	const messages: OpenAIMessage[] = [...initialMessages];
	const collected: CallResult["toolCalls"] = [];

	// `<=` so the model gets one final round AFTER the last allowed tool call
	// to synthesize its text reply from the recorded results.
	for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
		const body = {
			model: MODEL,
			messages,
			...(tools.length > 0 ? { tools, tool_choice: "auto" as const } : {}),
		};

		const res = await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${ENV.OPENAI_API_KEY}`,
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
		}
		const raw: unknown = await res.json();
		const parsed = v.safeParse(OpenAIChatResponseSchema, raw);
		if (!parsed.success) {
			throw new Error(`OpenAI returned unexpected shape: ${JSON.stringify(raw)}`);
		}
		const first = parsed.output.choices[0];
		if (first === undefined) throw new Error("OpenAI returned no choices");
		const message = first.message;

		if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
			messages.push({
				role: "assistant",
				content: message.content,
				tool_calls: message.tool_calls,
			});
			for (const call of message.tool_calls) {
				const args = safeParseJson(call.function.arguments);
				collected.push({ name: call.function.name, args });
				const result = lookupRecordedResult(call.function.name, recorded);
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: JSON.stringify(result),
				});
			}
			continue;
		}

		if (message.content === null || message.content === "") {
			throw new Error(
				`Model returned no content and no tool calls (round ${round}) — model: ${MODEL}`,
			);
		}
		return { agentText: message.content, toolCalls: collected };
	}

	throw new Error(
		`Model exceeded ${MAX_TOOL_ROUNDS} tool-calling rounds without producing a text reply`,
	);
}

function safeParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		// The model occasionally emits malformed args. Surface the raw string
		// instead of crashing; xray will store it and the diff will show it.
		return raw;
	}
}

// 0.0.0.0 bind is safe because compose.dev.yaml deliberately doesn't publish
// port 4000 to the host — the LAN can't reach this OPENAI_API_KEY-burning
// surface. Don't "harden" by switching to 127.0.0.1; that breaks Docker DNS
// from xray-dev (which is the only thing that needs to reach us).
const server = Bun.serve({
	port: PORT,
	hostname: "0.0.0.0",
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/healthz") {
			return new Response("ok\n");
		}
		if (req.method !== "POST" || url.pathname !== "/replay") {
			return new Response("not found\n", { status: 404 });
		}
		let body: unknown;
		try {
			body = await req.json();
		} catch {
			return Response.json({ error: "invalid_json" }, { status: 400 });
		}
		const parsed = v.safeParse(WebhookRequestSchema, body);
		if (!parsed.success) {
			console.error("invalid_shape:", parsed.issues);
			return Response.json({ error: "invalid_shape" }, { status: 400 });
		}
		const payload = parsed.output;

		const startedAt = Date.now();
		let result: CallResult;
		try {
			result = await callOpenAI(buildMessages(payload), payload.recordedToolResults);
		} catch (cause) {
			// Don't echo `cause` to the caller — the OpenAI error body leaks org id and tier.
			console.error(`turn ${payload.turnIdx} failed:`, cause);
			return Response.json({ error: "upstream_failed" }, { status: 502 });
		}
		const responseLatencyMs = Date.now() - startedAt;
		const toolSuffix =
			result.toolCalls.length > 0
				? ` [tools: ${result.toolCalls.map((c) => c.name).join(", ")}]`
				: "";
		console.info(
			`[${payload.sessionId}] turn ${payload.turnIdx} ${snippet(payload.userText)} → ${snippet(result.agentText)}${toolSuffix} (${responseLatencyMs}ms)`,
		);
		return Response.json({
			agentText: result.agentText,
			responseLatencyMs,
			toolCalls: result.toolCalls,
		});
	},
});

console.info(`agent-webhook listening on http://0.0.0.0:${server.port}`);
console.info(`  POST /replay   — xray webhook target`);
console.info(`  GET  /healthz  — liveness`);
console.info(`  model: ${MODEL}`);

function snippet(s: string): string {
	const max = 50;
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `"${flat.slice(0, max)}…"` : `"${flat}"`;
}

function parseArgs(argv: string[]): ScriptArgs {
	const out: ScriptArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined || !a.startsWith("--")) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		let value: string;
		if (next !== undefined && !next.startsWith("--")) {
			value = next;
			i += 1;
		} else {
			value = "true";
		}
		if (key === "port" || key === "model" || key === "system") {
			out[key] = value;
		}
		// Unknown flags are ignored — the script only takes the three above.
	}
	return out;
}
