import { count, eq } from "drizzle-orm";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import { conversations, replays } from "@/server/store/schema.ts";
import type { Store, StoreDbOrTx } from "@/server/store/store.ts";
import type { ConversationRow } from "@/server/store/types.ts";

import { RecordedAudioUploadKeyError } from "./conversations.errors.ts";
import type {
	ConversationResponse,
	ConversationSummary,
	ConversationTurn,
	ConversationTurnRequest,
} from "./conversations.types.ts";
import { TurnsArraySchema } from "./conversations.types.ts";

/** SHA-256 hex (64-char lowercase) of an arbitrary byte buffer. */
async function sha256Hex(bytes: BufferSource): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PendingAudioWrite {
	readonly sha256: string;
	readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface MaterializeResult {
	canonicalTurns: ConversationTurn[];
	/** Content-addressed pairs ready for `saveRecordedConversationAudio`. */
	audioWrites: PendingAudioWrite[];
}

function materializeOneTurn(
	turn: ConversationTurnRequest,
	sha256ByKey: ReadonlyMap<string, string>,
): ConversationTurn {
	const { audio, ...rest } = turn;
	return match(audio)
		.with(P.nullish, (): ConversationTurn => rest)
		.with({ kind: "tts" }, (a): ConversationTurn => ({ ...rest, audio: a }))
		.with({ kind: "recorded" }, (a): ConversationTurn => {
			const sha256 = sha256ByKey.get(a.upload_key);
			if (sha256 === undefined) throw new RecordedAudioUploadKeyError(a.upload_key, "missing");
			return { ...rest, audio: { kind: "recorded", sha256 } };
		})
		.exhaustive();
}

/**
 * Walk a request turn array, hash each referenced audio part, and produce
 * the canonical/stored form (with `{kind: "recorded", sha256}` substituted
 * in for `{kind: "recorded", upload_key}`).
 *
 * Hashing fans out via `Promise.all` so independent WAVs digest in parallel
 * — sha256 over a multi-MB buffer is the dominant cost on this path.
 *
 * Throws `RecordedAudioUploadKeyError` with `reason="missing"` when a turn
 * references a key absent from the multipart body, or with
 * `reason="unreferenced"` when the body carries an extra file part no turn
 * references — surfaced as a 400 so silent typos don't ghost-upload orphan
 * audio.
 */
export async function materializeRequestTurns(
	requestTurns: readonly ConversationTurnRequest[],
	audioBytesByKey: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
): Promise<MaterializeResult> {
	const referencedKeys = new Set<string>();
	for (const turn of requestTurns) {
		if (turn.audio?.kind === "recorded") referencedKeys.add(turn.audio.upload_key);
	}
	for (const key of audioBytesByKey.keys()) {
		if (!referencedKeys.has(key)) throw new RecordedAudioUploadKeyError(key, "unreferenced");
	}
	for (const key of referencedKeys) {
		if (!audioBytesByKey.has(key)) throw new RecordedAudioUploadKeyError(key, "missing");
	}

	const hashed = await Promise.all(
		[...audioBytesByKey].map(async ([key, bytes]) => ({
			key,
			sha256: await sha256Hex(bytes),
			bytes,
		})),
	);
	const sha256ByKey = new Map(hashed.map(({ key, sha256 }) => [key, sha256] as const));
	const canonicalTurns = requestTurns.map((turn) => materializeOneTurn(turn, sha256ByKey));
	const audioWrites: PendingAudioWrite[] = hashed.map(({ sha256, bytes }) => ({ sha256, bytes }));
	return { canonicalTurns, audioWrites };
}

/**
 * Canonical-JSON encode + SHA-256 hex a canonical turn array. The conversation
 * hash is this value; the bytes stored in `turns_json` are this canonical JSON.
 * Server-only — the SDK never hashes anything.
 */
export async function canonicalizeAndHashTurns(
	turns: readonly ConversationTurn[],
): Promise<{ json: string; hash: string }> {
	const json = canonicalStringify(turns);
	const hash = await sha256Hex(new TextEncoder().encode(json));
	return { json, hash };
}

export interface EnsureConversationInput {
	hash: string;
	name: string;
	turnsJson: string;
	now: string;
}

/**
 * Idempotent upsert of a Conversation row keyed by `hash`. On first POST
 * inserts; on subsequent POSTs with the same hash, updates `name`
 * (last-write-wins on display label) and bumps `last_run_at` to `now`.
 *
 * `last_run_at` is the time of the most recent POST to
 * `/v1/conversations` — used as the sort key on the conversations list.
 * It is NOT derived from `replays.started_at`; the SDK orchestrator
 * POSTs the conversation at the start of every run, which makes this a
 * reasonable proxy for "last activity" in practice.
 *
 * Accepts either the top-level `StoreDb` or a transaction handle so a
 * caller can compose this with sibling inserts atomically — see
 * `createReplay` in `replays.service.ts`.
 */
export function ensureConversation(
	db: StoreDbOrTx,
	{ hash, name, turnsJson, now }: EnsureConversationInput,
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

function parseStoredTurns(raw: string, hash: string): ConversationTurn[] {
	// Stored rows were validated on the way in; a corrupt row (botched
	// migration, fsck'd file) shouldn't 500 the entire conversation handler.
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch (err) {
		console.warn(
			"[conversations] turns_json JSON.parse failed for hash=%s; returning empty turns. err=%s",
			hash,
			err instanceof Error ? err.message : String(err),
		);
		return [];
	}
	const result = v.safeParse(TurnsArraySchema, parsedJson);
	if (!result.success) {
		console.warn(
			"[conversations] turns_json schema validation failed for hash=%s; returning empty turns. issues=%s",
			hash,
			JSON.stringify(result.issues.map((i) => ({ path: i.path, message: i.message }))),
		);
		return [];
	}
	return result.output;
}

/** Project a stored row back onto the wire response shape. */
export function toConversationResponse(row: ConversationRow): ConversationResponse {
	return {
		hash: row.hash,
		name: row.name,
		created_at: row.createdAt,
		last_run_at: row.lastRunAt,
		turns: parseStoredTurns(row.turnsJson, row.hash),
	};
}

/** List all conversations, newest-active first. One row per hash. */
export function listConversations(store: Store): ConversationSummary[] {
	const rows = store.db
		.select({
			hash: conversations.hash,
			name: conversations.name,
			createdAt: conversations.createdAt,
			lastRunAt: conversations.lastRunAt,
		})
		.from(conversations)
		.all();
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
 * Canonical JSON: sorted keys, no whitespace, ASCII-only output. The
 * conversation hash is `sha256(canonicalStringify(canonicalTurns))`. This
 * is now server-only (the SDK no longer hashes), but the encoding is still
 * pinned because changing it would invalidate every stored conversation
 * hash retroactively.
 *
 * Numbers are deliberately rejected: `JSON.stringify(1.0)` is `"1"` while
 * Python's `json.dumps(1.0)` is `"1.0"`, and JS+Python disagree on large-int
 * boundaries and `-0`. Until a numeric field is actually needed, locking
 * the input to null/bool/string/object/array forecloses an entire class of
 * "the encoder picked something surprising for this value" bugs.
 */
export function canonicalStringify(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		throw new TypeError(
			"Cannot canonicalize a number: JS+Python JSON encoders disagree on numeric formatting (floats, large ints, -0). Add a normalized encoding before introducing a numeric field.",
		);
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
