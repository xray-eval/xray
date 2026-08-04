/**
 * What the committed fixture contains: the two conversations a developer would
 * have authored, the five run configs they were run under, and the seven
 * replays that pairing produces — plus the lookups the seeder resolves them
 * through. Pure data; nothing here touches the store, the audio or the spans.
 */

import { TOOL_BY_CONVERSATION } from "./seed-snapshot.trace.ts";
import type {
	ConversationKey,
	RunVariant,
	ScriptedConversation,
	ScriptedTurn,
} from "./seed-snapshot.types.ts";

const BARGE_IN_SCRIPT: readonly ScriptedTurn[] = [
	{
		role: "user",
		startMs: 0,
		endMs: 1800,
		amplitude: 6_000,
		transcript: "Book me a flight to Paris.",
	},
	// The agent starts answering, gets cut off, and keeps talking ~300ms.
	{
		role: "agent",
		startMs: 2300,
		endMs: 4600,
		amplitude: 9_000,
		transcript: "Sure — I'm booking a flight to Paris",
	},
	// The user barges in 300ms before the agent stops (4300 < 4600).
	{ role: "user", startMs: 4300, endMs: 5500, amplitude: 12_000, transcript: "No, wait — Berlin!" },
	{
		role: "agent",
		startMs: 6000,
		endMs: 8000,
		amplitude: 15_000,
		transcript: "Got it, booking a flight to Berlin instead.",
	},
];

// A short, clean two-turn exchange: no interruption, so `yield_ms` has no
// sample here and the compare view shows a metric whose `n` legitimately
// differs per row. Also a third of the audio bytes of the barge-in script,
// which is what keeps a 5-config fixture from dominating the repo.
const LOOKUP_SCRIPT: readonly ScriptedTurn[] = [
	{
		role: "user",
		startMs: 0,
		endMs: 1200,
		amplitude: 18_000,
		transcript: "What time is my flight?",
	},
	{
		role: "agent",
		startMs: 1600,
		endMs: 3200,
		amplitude: 21_000,
		transcript: "Your flight leaves at 6pm.",
	},
];

// The conversations the developer would have authored. interrupt_after_ms marks
// the barge-in; the agent turn it interrupts must yield within 500ms, and the
// recovery turn must mention the corrected city.
export const CONVERSATIONS: readonly ScriptedConversation[] = [
	{
		key: "barge-in",
		name: "user corrects destination mid-answer",
		script: BARGE_IN_SCRIPT,
		recordingEndMs: 8200,
		specTurns: [
			{ role: "user", text: BARGE_IN_SCRIPT[0]?.transcript ?? "", assertions: [] },
			{ role: "agent", assertions: [{ kind: "yielded_within_ms", max_ms: 500 }] },
			{
				role: "user",
				text: BARGE_IN_SCRIPT[2]?.transcript ?? "",
				interrupt_after_ms: 2000,
				assertions: [],
			},
			{
				role: "agent",
				assertions: [
					{ kind: "contains", text: "Berlin", case_insensitive: true },
					{ kind: "tool_called", name: TOOL_BY_CONVERSATION["barge-in"] },
				],
			},
		],
	},
	{
		key: "lookup",
		name: "user asks when their flight leaves",
		script: LOOKUP_SCRIPT,
		recordingEndMs: 3400,
		specTurns: [
			{ role: "user", text: LOOKUP_SCRIPT[0]?.transcript ?? "", assertions: [] },
			{
				role: "agent",
				assertions: [
					{ kind: "contains", text: "6pm", case_insensitive: true },
					{ kind: "tool_called", name: TOOL_BY_CONVERSATION.lookup },
				],
			},
		],
	},
];

export const ALL_SCRIPTED_TURNS: readonly ScriptedTurn[] = CONVERSATIONS.flatMap((c) => c.script);

/** What `assertReplayIsGreen` holds each replay's evaluation to. */
export const DECLARED_ASSERTIONS_BY_CONVERSATION: Readonly<Record<ConversationKey, number>> = {
	"barge-in": countAssertions("barge-in"),
	lookup: countAssertions("lookup"),
};

function countAssertions(key: ConversationKey): number {
	return requireConversation(key).specTurns.reduce((n, turn) => n + turn.assertions.length, 0);
}

/**
 * Five configurations, so the comparison view has a realistic spread on a fresh
 * checkout. `agentDelayMs` shifts only the *start* of each agent turn, never its
 * end: that moves `agent_response_ms` (the number the configs differ on) while
 * leaving the barge-in overlap — and therefore `yield_ms` and the
 * `yielded_within_ms` assertion — identical. Every run passes; they differ only
 * on how quickly the agent gets going.
 *
 * `temperature` is a float on purpose: it exercises the run-config canonicalizer
 * that the conversation one can't handle.
 */
const RUN_VARIANTS: readonly RunVariant[] = [
	{ key: "baseline", configName: "baseline", config: { model: "gpt-4o" }, agentDelayMs: 0 },
	{
		key: "fast-follow",
		configName: "fast-follow",
		config: { model: "gemini-2.5-flash" },
		agentDelayMs: -250,
	},
	{
		key: "precise",
		configName: "precise",
		config: { model: "gpt-4o", temperature: 0.2 },
		agentDelayMs: 120,
	},
	{ key: "mini", configName: "mini", config: { model: "gpt-4o-mini" }, agentDelayMs: -100 },
	{
		key: "flash-tuned",
		configName: "flash-tuned",
		config: { model: "gemini-2.5-flash", temperature: 0.9, top_p: 0.8 },
		agentDelayMs: 350,
	},
];

export interface SeedReplay {
	readonly replayId: string;
	readonly variantKey: string;
	readonly conversationKey: ConversationKey;
	readonly startedAt: string;
}

/**
 * One row per replay, with a hand-assigned id so the fixture stays stable across
 * regenerations. Only two configs ran the barge-in conversation: that partial
 * coverage is what the compare view's fair-comparison warning is for, so the
 * fixture has to contain a case that triggers it.
 *
 * `...0001` is the barge-in run this fixture has always held and its WAV is
 * byte-identical — the inspector's canonical example is unchanged. `...0002` is
 * a second run of that same conversation under `fast-follow`, so the barge-in
 * conversation has more than one config to compare.
 */

export const SEED_REPLAYS: readonly SeedReplay[] = [
	{
		replayId: "ba9e1000-0000-4000-8000-000000000001",
		variantKey: "baseline",
		conversationKey: "barge-in",
		startedAt: "2026-07-01T12:00:00.000Z",
	},
	{
		replayId: "ba9e1000-0000-4000-8000-000000000002",
		variantKey: "fast-follow",
		conversationKey: "barge-in",
		startedAt: "2026-07-01T12:05:00.000Z",
	},
	{
		replayId: "ba9e1000-0000-4000-8000-000000000003",
		variantKey: "baseline",
		conversationKey: "lookup",
		startedAt: "2026-07-02T09:00:00.000Z",
	},
	{
		replayId: "ba9e1000-0000-4000-8000-000000000004",
		variantKey: "fast-follow",
		conversationKey: "lookup",
		startedAt: "2026-07-02T09:05:00.000Z",
	},
	{
		replayId: "ba9e1000-0000-4000-8000-000000000005",
		variantKey: "precise",
		conversationKey: "lookup",
		startedAt: "2026-07-02T09:10:00.000Z",
	},
	{
		replayId: "ba9e1000-0000-4000-8000-000000000006",
		variantKey: "mini",
		conversationKey: "lookup",
		startedAt: "2026-07-02T09:15:00.000Z",
	},
	{
		replayId: "ba9e1000-0000-4000-8000-000000000007",
		variantKey: "flash-tuned",
		conversationKey: "lookup",
		startedAt: "2026-07-02T09:20:00.000Z",
	},
];

export function requireVariant(key: string): RunVariant {
	const variant = RUN_VARIANTS.find((candidate) => candidate.key === key);
	if (variant === undefined) throw new Error(`seed-snapshot: unknown run variant "${key}"`);
	return variant;
}

export function requireConversation(key: ConversationKey): ScriptedConversation {
	const conversation = CONVERSATIONS.find((c) => c.key === key);
	if (conversation === undefined) throw new Error(`seed-snapshot: unknown conversation "${key}"`);
	return conversation;
}
