/**
 * The scripted-conversation shapes. They sit in a leaf of their own so their
 * four consumers (the seeder, the catalog, the audio synthesis and the trace
 * builder) form a DAG — whichever module owned them would otherwise be imported
 * by the ones it imports.
 */

import type { ConversationTurn } from "@/server/conversations/conversations.types.ts";

/** Closed on purpose: the trace builder indexes its per-conversation tables by it. */
export type ConversationKey = "barge-in" | "lookup";

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
