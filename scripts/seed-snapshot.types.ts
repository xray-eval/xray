/**
 * Shapes shared by the snapshot seeder and its OTLP trace builder. They live
 * here rather than in `seed-snapshot.ts` because the trace builder needs them
 * too, and importing them back out of the seeder would make the two files a
 * cycle.
 */

import type { ConversationTurn } from "@/server/conversations/conversations.types.ts";

/** Every scripted conversation, keyed so the trace builder can look one up. */
export type ConversationKey = "barge-in" | "lookup";

// One line per turn. The distinct amplitude doubles as the marker the
// stand-in transcription provider reads back to recover the line — so
// amplitudes are unique across BOTH scripts, not just within one.
export interface ScriptedTurn {
	readonly role: "user" | "agent";
	readonly startMs: number;
	readonly endMs: number;
	readonly amplitude: number;
	readonly transcript: string;
}

export interface ScriptedConversation {
	readonly key: ConversationKey;
	readonly name: string;
	readonly script: readonly ScriptedTurn[];
	readonly specTurns: readonly ConversationTurn[];
	readonly recordingEndMs: number;
}

export interface RunVariant {
	readonly key: string;
	readonly configName: string;
	readonly config: Record<string, string | number>;
	readonly agentDelayMs: number;
}
