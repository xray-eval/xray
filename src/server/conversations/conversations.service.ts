import { and, asc, count, desc, eq, max } from "drizzle-orm";
import * as v from "valibot";

import { conversations, replays } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import type { ConversationRow } from "@/server/store/types.ts";

import { VersionFingerprintMismatchError } from "./conversations.errors.ts";
import type {
	ConversationResponse,
	ConversationSpec,
	ConversationSummary,
	ConversationTurn,
} from "./conversations.types.ts";
import { ConversationTurnSchema } from "./conversations.types.ts";

const TurnArraySchema = v.array(ConversationTurnSchema);

/**
 * Upsert a Conversation row keyed by `(id, version)`.
 *
 * Idempotent: re-POSTing the same `(id, version)` with byte-identical
 * `turns_json` returns the existing row. POSTing the same `(id, version)`
 * with different turn content throws `VersionFingerprintMismatchError` —
 * the dev forgot to bump version after editing the spec.
 *
 * The fingerprint is the canonical JSON-stringified turn array; the SDK
 * computes the same string before sending so a "trivial reorder" upstream
 * is still caught.
 */
export function upsertConversation(
	store: Store,
	spec: ConversationSpec,
	now: () => string = () => new Date().toISOString(),
): ConversationRow {
	const turnsJson = canonicalizeTurns(spec.turns);
	const existing = store.db
		.select()
		.from(conversations)
		.where(and(eq(conversations.id, spec.id), eq(conversations.version, spec.version)))
		.get();
	if (existing !== undefined) {
		if (existing.turnsJson !== turnsJson) {
			throw new VersionFingerprintMismatchError(spec.id, spec.version);
		}
		return existing;
	}
	const row: ConversationRow = {
		id: spec.id,
		version: spec.version,
		turnsJson,
		title: spec.title ?? null,
		createdAt: now(),
	};
	store.db.insert(conversations).values(row).run();
	return row;
}

/** Stable canonical encoding of turn structure used as the version fingerprint. */
export function canonicalizeTurns(turns: readonly ConversationTurn[]): string {
	return JSON.stringify(turns);
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
		id: row.id,
		version: row.version,
		title: row.title,
		createdAt: row.createdAt,
		turns: parseStoredTurns(row.turnsJson),
	};
}

/**
 * List one row per distinct `id` — for each id, the latest version's
 * metadata plus the count of versions and the count of replays across all
 * versions. Sorted newest-first.
 */
export function listConversations(store: Store): ConversationSummary[] {
	// Two queries; the join would multiply row counts and force GROUP BY
	// gymnastics. The conversation list is small (per-dev), so two indexed
	// scans are fine.
	const versionRows = store.db
		.select({
			id: conversations.id,
			latestCreatedAt: max(conversations.createdAt),
			versions: count(),
		})
		.from(conversations)
		.groupBy(conversations.id)
		.all();

	const replayCountRows = store.db
		.select({ conversationId: replays.conversationId, replays: count() })
		.from(replays)
		.groupBy(replays.conversationId)
		.all();
	const replayCounts = new Map(replayCountRows.map((r) => [r.conversationId, r.replays] as const));

	const summaries: ConversationSummary[] = [];
	for (const row of versionRows) {
		if (row.latestCreatedAt === null) continue;
		const latest = store.db
			.select()
			.from(conversations)
			.where(and(eq(conversations.id, row.id), eq(conversations.createdAt, row.latestCreatedAt)))
			.get();
		if (latest === undefined) continue;
		summaries.push({
			id: row.id,
			latestVersion: latest.version,
			title: latest.title,
			createdAt: latest.createdAt,
			versions: row.versions,
			replays: replayCounts.get(row.id) ?? 0,
		});
	}
	summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
	return summaries;
}

/** Get the latest version of a conversation, or undefined. */
export function getLatestConversation(store: Store, id: string): ConversationRow | undefined {
	return store.db
		.select()
		.from(conversations)
		.where(eq(conversations.id, id))
		.orderBy(desc(conversations.createdAt))
		.limit(1)
		.get();
}

/** Get one specific `(id, version)` or undefined. */
export function getConversationVersion(
	store: Store,
	id: string,
	version: string,
): ConversationRow | undefined {
	return store.db
		.select()
		.from(conversations)
		.where(and(eq(conversations.id, id), eq(conversations.version, version)))
		.get();
}

/** All versions of a conversation, oldest-first. */
export function listConversationVersions(store: Store, id: string): ConversationRow[] {
	return store.db
		.select()
		.from(conversations)
		.where(eq(conversations.id, id))
		.orderBy(asc(conversations.createdAt))
		.all();
}
