import { count, eq } from "drizzle-orm";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import type { Judge } from "@/server/judges/judges.types.ts";
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
import { StoredConversationSpecSchema } from "./conversations.types.ts";

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
 * Canonical-JSON encode + SHA-256 hex the full conversation spec (turns +
 * conversation-level judges). The conversation hash is this value; the
 * bytes stored in `conversations.turns_json` are this canonical JSON. The
 * column name is legacy — it carries the full spec object now, not just
 * the turns array. Server-only — the SDK never hashes anything.
 *
 * Why judges are in the hash: changing the assertions or judges on a
 * conversation changes the *test*, even if the script is identical. Two
 * conversations with the same turns but different judges are two
 * different tests, so they need two different hashes.
 */
export async function canonicalizeAndHashSpec(
	turns: readonly ConversationTurn[],
	judges: readonly Judge[],
	live = false,
): Promise<{ json: string; hash: string }> {
	// A live session has no script, so two live runs would otherwise
	// canonicalize to the identical (empty) spec and collapse onto one
	// conversation row. Fold a server-generated salt into the live spec so
	// every live POST mints a distinct hash. Non-live specs stay byte-for-byte
	// unchanged — their stored hashes must remain stable across this change.
	const spec = live
		? ({ turns, judges, live: true, live_salt: crypto.randomUUID() } as const)
		: ({ turns, judges } as const);
	const json = canonicalStringify(spec);
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

function parseStoredSpec(
	raw: string,
	hash: string,
): { turns: ConversationTurn[]; judges: Judge[]; live: boolean } {
	// Stored rows were validated on the way in; a corrupt row (botched
	// migration, fsck'd file) shouldn't 500 the entire conversation handler.
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch (err) {
		console.warn(
			"[conversations] turns_json JSON.parse failed for hash=%s; returning empty spec. err=%s",
			hash,
			err instanceof Error ? err.message : String(err),
		);
		return { turns: [], judges: [], live: false };
	}
	const result = v.safeParse(StoredConversationSpecSchema, parsedJson);
	if (!result.success) {
		console.warn(
			"[conversations] turns_json schema validation failed for hash=%s; returning empty spec. issues=%s",
			hash,
			JSON.stringify(result.issues.map((i) => ({ path: i.path, message: i.message }))),
		);
		return { turns: [], judges: [], live: false };
	}
	return { turns: result.output.turns, judges: result.output.judges, live: result.output.live };
}

/** Project a stored row back onto the wire response shape. */
export function toConversationResponse(row: ConversationRow): ConversationResponse {
	const { turns, judges, live } = parseStoredSpec(row.turnsJson, row.hash);
	return {
		hash: row.hash,
		name: row.name,
		created_at: row.createdAt,
		last_run_at: row.lastRunAt,
		turns,
		judges,
		live,
	};
}

/** Read the canonical spec stored in `conversations.turns_json`. Used by
 *  the evaluate-replay job to walk per-turn assertions + judges, and by
 *  calculate-metrics to decide whether to skip evaluation for a live run. */
export function getConversationSpec(
	store: Store,
	hash: string,
): { turns: ConversationTurn[]; judges: Judge[]; live: boolean } | undefined {
	const row = store.db.select().from(conversations).where(eq(conversations.hash, hash)).get();
	if (row === undefined) return undefined;
	return parseStoredSpec(row.turnsJson, row.hash);
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
 * Canonical JSON: sorted keys, no whitespace, ASCII-only output, integer
 * numbers only. The conversation hash is
 * `sha256(canonicalStringify(spec))`. This is server-only (the SDK no
 * longer hashes), but the encoding is still pinned because changing it
 * would invalidate every stored conversation hash retroactively.
 *
 * Integers serialize as their decimal string — JS `JSON.stringify(2000)`
 * and Python `json.dumps(2000)` both produce `"2000"`. Floats, NaN, and
 * non-finite values are rejected because the two encoders diverge there
 * (`JSON.stringify(1.0)` is `"1"`, `json.dumps(1.0)` is `"1.0"`). `-0` is
 * normalized to `0` for the same reason.
 *
 * If a float field is ever needed at this boundary, add a separate
 * encoder (e.g. fixed-precision decimal as string) before relaxing this
 * check.
 */
export function canonicalStringify(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError("Cannot canonicalize NaN or +/-Infinity");
		}
		if (!Number.isInteger(value)) {
			throw new TypeError(
				`Cannot canonicalize non-integer number ${value}: JS+Python JSON encoders disagree on float formatting. Use an integer or a string.`,
			);
		}
		// Normalize -0 to 0 so the encoded form is stable.
		return String(value === 0 ? 0 : value);
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
