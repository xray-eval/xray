import type { ConversationSpec, ConversationTurn } from "./conversations.types.ts";

let counter = 0;

export function makeConversationTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
	return {
		role: "user",
		text: "hello",
		...overrides,
	};
}

export function makeConversationSpec(overrides: Partial<ConversationSpec> = {}): ConversationSpec {
	counter += 1;
	return {
		id: `conv-${counter}`,
		version: "v0001",
		turns: [
			makeConversationTurn({ role: "user", text: "hi", key: "u0" }),
			makeConversationTurn({ role: "agent", key: "a0" }),
		],
		...overrides,
	};
}
