import { count, eq } from "drizzle-orm";
import * as v from "valibot";

import { conversations, replays } from "@/server/store/schema.ts";
import type { Store, StoreDbOrTx } from "@/server/store/store.ts";
import type { ConversationRow } from "@/server/store/types.ts";

import type {
	ConversationResponse,
	ConversationSummary,
	ConversationTurn,
} from "./conversations.types.ts";
import { ConversationTurnSchema } from "./conversations.types.ts";

const TurnArraySchema = v.array(ConversationTurnSchema);

/**
 * Compute the canonical encoding of a turn array used as the input to the
 * conversation hash. Both the SDK and server must produce bit-identical
 * bytes here; a parity fixture (`tests/fixtures/hash-parity.json`) pins
 * the contract.
 *
 * Rules: sorted keys, no whitespace, ASCII-safe (any non-ASCII is escaped).
 */
export function canonicalizeTurns(turns: readonly ConversationTurn[]): string {
	return canonicalStringify(turns);
}

/**
 * SHA-256 hex (64-char lowercase) over `canonicalizeTurns(turns)`. The
 * SDK computes the same hash before POSTing; the server recomputes from
 * the embedded spec on the wire — never trusts an SDK-computed value.
 */
export async function computeConversationHash(turns: readonly ConversationTurn[]): Promise<string> {
	return (await canonicalizeAndHashTurns(turns)).hash;
}

/**
 * Single walk over the turn tree: returns both the canonical JSON and its
 * SHA-256 hex. `createReplay` uses this so the bytes stored in `turns_json`
 * are byte-identical to the bytes that produced the conversation hash —
 * and the tree is walked once, not twice.
 */
export async function canonicalizeAndHashTurns(
	turns: readonly ConversationTurn[],
): Promise<{ json: string; hash: string }> {
	const json = canonicalizeTurns(turns);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
	const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return { json, hash };
}

/**
 * Idempotent upsert of a Conversation row keyed by `hash`. On first POST
 * inserts; on subsequent POSTs with the same hash, updates `name`
 * (last-write-wins on display label) and `last_run_at` (denormalized for
 * list ordering).
 *
 * Accepts either the top-level `StoreDb` or a transaction handle so a
 * caller can compose this with sibling inserts atomically — see
 * `createReplay` in `replays.service.ts`.
 */
export function ensureConversation(
	db: StoreDbOrTx,
	hash: string,
	name: string,
	turnsJson: string,
	now: string,
): ConversationRow {
	const existing = db.select().from(conversations).where(eq(conversations.hash, hash)).get();
	if (existing !== undefined) {
		db.update(conversations)
			.set({ name, lastRunAt: now })
			.where(eq(conversations.hash, hash))
			.run();
		return { ...existing, name, lastRunAt: now };
	}
	const row: ConversationRow = {
		hash,
		name,
		turnsJson,
		createdAt: now,
		lastRunAt: now,
	};
	db.insert(conversations).values(row).run();
	return row;
}

function parseStoredTurns(raw: string): ConversationTurn[] {
	// Stored rows were validated on the way in; a corrupt row (botched
	// migration, fsck'd file) shouldn't 500 the entire conversation handler.
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		return [];
	}
	const result = v.safeParse(TurnArraySchema, parsedJson);
	return result.success ? result.output : [];
}

/** Project a stored row back onto the wire response shape. */
export function toConversationResponse(row: ConversationRow): ConversationResponse {
	return {
		hash: row.hash,
		name: row.name,
		created_at: row.createdAt,
		last_run_at: row.lastRunAt,
		turns: parseStoredTurns(row.turnsJson),
	};
}

/** List all conversations, newest-active first. One row per hash. */
export function listConversations(store: Store): ConversationSummary[] {
	const rows = store.db.select().from(conversations).all();
	const replayCountRows = store.db
		.select({ conversationHash: replays.conversationHash, n: count() })
		.from(replays)
		.groupBy(replays.conversationHash)
		.all();
	const replayCounts = new Map(replayCountRows.map((r) => [r.conversationHash, r.n] as const));
	const summaries: ConversationSummary[] = rows.map((row) => ({
		hash: row.hash,
		name: row.name,
		created_at: row.createdAt,
		last_run_at: row.lastRunAt,
		replays: replayCounts.get(row.hash) ?? 0,
	}));
	summaries.sort((a, b) => {
		const ax = a.last_run_at ?? a.created_at;
		const bx = b.last_run_at ?? b.created_at;
		return ax < bx ? 1 : ax > bx ? -1 : 0;
	});
	return summaries;
}

export function getConversationByHash(store: Store, hash: string): ConversationRow | undefined {
	return store.db.select().from(conversations).where(eq(conversations.hash, hash)).get();
}

/**
 * Canonical JSON: sorted keys, no whitespace, ASCII-only output. Mirrors
 * Python's `json.dumps(..., separators=(",", ":"), sort_keys=True,
 * ensure_ascii=True)`. Used for the conversation hash; the parity fixture
 * exercises it.
 */
function canonicalStringify(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError("Cannot canonicalize non-finite number");
		}
		return JSON.stringify(value);
	}
	if (typeof value === "string") return escapeAscii(value);
	if (Array.isArray(value)) {
		const parts = value.map((item) => canonicalStringify(item));
		return `[${parts.join(",")}]`;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const parts = entries.map(([k, val]) => `${escapeAscii(k)}:${canonicalStringify(val)}`);
		return `{${parts.join(",")}}`;
	}
	throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

/** ASCII-safe JSON string escape. Matches Python's `ensure_ascii=True`. */
function escapeAscii(s: string): string {
	let out = '"';
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code === 0x22) out += '\\"';
		else if (code === 0x5c) out += "\\\\";
		else if (code === 0x08) out += "\\b";
		else if (code === 0x09) out += "\\t";
		else if (code === 0x0a) out += "\\n";
		else if (code === 0x0c) out += "\\f";
		else if (code === 0x0d) out += "\\r";
		else if (code < 0x20 || code > 0x7e) {
			out += `\\u${code.toString(16).padStart(4, "0")}`;
		} else {
			out += s[i];
		}
	}
	out += '"';
	return out;
}
