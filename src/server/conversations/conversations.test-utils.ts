import { conversations } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";

import { canonicalizeAndHashTurns } from "./conversations.service.ts";
import type { ConversationTurn, ConversationTurnRequest } from "./conversations.types.ts";

let counter = 0;

export function makeConversationTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
	// Agent turns carry no text in the canonical wire shape, so don't inherit
	// the user-turn default `text` when the override picks `role: "agent"`.
	const base: ConversationTurn =
		overrides.role === "agent" ? { role: "agent" } : { role: "user", text: "hello" };
	return { ...base, ...overrides };
}

export interface MakeTurnsOptions {
	turns?: ConversationTurn[];
}

export function makeTurns(opts: MakeTurnsOptions = {}): ConversationTurn[] {
	if (opts.turns !== undefined) return opts.turns;
	return [
		makeConversationTurn({ role: "user", text: "hi", key: "u0" }),
		makeConversationTurn({ role: "agent", key: "a0" }),
	];
}

/** Request-form analogue of `makeTurns` — same shape, different audio union. */
export function makeRequestTurns(overrides?: ConversationTurnRequest[]): ConversationTurnRequest[] {
	if (overrides !== undefined) return overrides;
	return [
		{ role: "user", text: "hi", key: "u0" },
		{ role: "agent", key: "a0" },
	];
}

export interface SeedConversationOverrides {
	name?: string;
	turns?: ConversationTurn[];
	createdAt?: string;
	lastRunAt?: string | null;
}

/**
 * Insert a conversation row directly into the test store and return the
 * computed content hash. Each call hashes a slightly different set of turns
 * so that successive calls produce distinct hashes without overrides.
 *
 * Idempotent: re-seeding the same canonical turn array is a no-op via
 * `ON CONFLICT DO NOTHING`. Callers that need a fresh hash should override
 * `turns` to vary the canonical input.
 */
export async function seedConversation(
	store: Store,
	overrides: SeedConversationOverrides = {},
): Promise<{ hash: string; name: string }> {
	counter += 1;
	const turns = overrides.turns ?? [
		makeConversationTurn({ role: "user", text: `hi-${counter}`, key: `u${counter}` }),
		makeConversationTurn({ role: "agent", key: `a${counter}` }),
	];
	const name = overrides.name ?? `Conversation ${counter}`;
	const createdAt = overrides.createdAt ?? "2026-05-18T11:00:00.000Z";
	const lastRunAt = overrides.lastRunAt === undefined ? null : overrides.lastRunAt;
	const { json: turnsJson, hash } = await canonicalizeAndHashTurns(turns);
	store.db
		.insert(conversations)
		.values({ hash, name, turnsJson, createdAt, lastRunAt })
		.onConflictDoNothing()
		.run();
	return { hash, name };
}
