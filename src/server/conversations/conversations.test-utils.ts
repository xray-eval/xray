import type { ConversationTurn, ConversationTurnRequest } from "./conversations.types.ts";

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
