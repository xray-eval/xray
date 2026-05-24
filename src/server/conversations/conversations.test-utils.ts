import type { Judge } from "@/server/judges/judges.types.ts";
import { conversations } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";

import { canonicalizeAndHashSpec } from "./conversations.service.ts";
import type { ConversationTurn, ConversationTurnRequest } from "./conversations.types.ts";

let counter = 0;

export function makeConversationTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
	// Agent turns carry no text in the canonical wire shape, so don't inherit
	// the user-turn default `text` when the override picks `role: "agent"`.
	const base: ConversationTurn =
		overrides.role === "agent"
			? { role: "agent", assertions: [] }
			: { role: "user", text: "hello", assertions: [] };
	return { ...base, ...overrides };
}

export interface MakeTurnsOptions {
	turns?: Partial<ConversationTurn>[];
}

export function makeTurns(opts: MakeTurnsOptions = {}): ConversationTurn[] {
	if (opts.turns !== undefined) return opts.turns.map((t) => makeConversationTurn(t));
	return [
		makeConversationTurn({ role: "user", text: "hi", key: "u0" }),
		makeConversationTurn({ role: "agent", key: "a0" }),
	];
}

/** Request-form analogue of `makeTurns` — same shape, different audio union. */
export function makeRequestTurns(
	overrides?: Partial<ConversationTurnRequest>[],
): ConversationTurnRequest[] {
	if (overrides !== undefined) return overrides.map((t) => makeRequestTurn(t));
	return [
		{ role: "user", text: "hi", key: "u0", assertions: [] },
		{ role: "agent", key: "a0", assertions: [] },
	];
}

function makeRequestTurn(
	overrides: Partial<ConversationTurnRequest> = {},
): ConversationTurnRequest {
	const base: ConversationTurnRequest =
		overrides.role === "agent"
			? { role: "agent", assertions: [] }
			: { role: "user", text: "hello", assertions: [] };
	return { ...base, ...overrides };
}

export interface SeedConversationOverrides {
	name?: string;
	turns?: ConversationTurn[];
	judges?: Judge[];
	createdAt?: string;
	lastRunAt?: string | null;
}

/**
 * Insert a conversation row directly into the test store and return the
 * computed content hash. Each call hashes a slightly different set of turns
 * so that successive calls produce distinct hashes without overrides.
 *
 * Idempotent: re-seeding the same canonical spec is a no-op via
 * `ON CONFLICT DO NOTHING`. Callers that need a fresh hash should override
 * `turns` (or `judges`) to vary the canonical input.
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
	const judges = overrides.judges ?? [];
	const name = overrides.name ?? `Conversation ${counter}`;
	const createdAt = overrides.createdAt ?? "2026-05-18T11:00:00.000Z";
	const lastRunAt = overrides.lastRunAt === undefined ? null : overrides.lastRunAt;
	const { json: turnsJson, hash } = await canonicalizeAndHashSpec(turns, judges);
	store.db
		.insert(conversations)
		.values({ hash, name, turnsJson, createdAt, lastRunAt })
		.onConflictDoNothing()
		.run();
	return { hash, name };
}
