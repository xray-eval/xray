import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { replays, runConfigs } from "@/server/store/schema.ts";
import type { Store, StoreDbOrTx } from "@/server/store/store.ts";
import type { RunConfigRow } from "@/server/store/types.ts";

import { canonicalRunConfigJson, hashRunConfig } from "./run-configs.hash.ts";

/**
 * Group membership: deciding which run-config group a replay belongs to and
 * what that group is called. The read side — coverage, aggregates, the
 * drill-down — lives in `run-configs.service.ts` and never writes.
 */

export interface EnsureRunConfigInput {
	readonly config: unknown;
	readonly name?: string;
	readonly now: string;
}

/**
 * Idempotent upsert of a run-config group keyed by content hash. Inserts on
 * first sight, else applies the display label.
 *
 * Two deliberate differences from `ensureConversation`:
 *
 * 1. An **unnamed** write never erases an existing label. `name` is required
 *    on conversations but optional here, so "no name" means "the caller said
 *    nothing about the label", not "the label is now empty" — otherwise every
 *    run by a dev who omits `RunConfig(name=...)` would strip the label a
 *    teammate set.
 * 2. `created_at` is not touched on upsert: a group is as old as its first
 *    run, and there's no `last_run_at` to bump because that's derivable from
 *    the replays pointing at it.
 *
 * `config_json` stores the *canonical* encoding, not the caller's byte order,
 * so the group's rendered config is deterministic. The verbatim per-replay
 * copy stays on `replays.run_config_json`.
 *
 * Takes `StoreDb` or a transaction handle so `createReplay` can compose the
 * group upsert and the replay insert atomically.
 *
 * Throws `UnhashableRunConfigError` when the config holds a value JSON cannot
 * represent.
 */
export function ensureRunConfig(db: StoreDbOrTx, input: EnsureRunConfigInput): RunConfigRow {
	const hash = hashRunConfig(input.config);
	const existing = db.select().from(runConfigs).where(eq(runConfigs.hash, hash)).get();
	if (existing !== undefined) {
		if (input.name === undefined || input.name === existing.name) return existing;
		db.update(runConfigs).set({ name: input.name }).where(eq(runConfigs.hash, hash)).run();
		return { ...existing, name: input.name };
	}
	const row: RunConfigRow = {
		hash,
		name: input.name ?? null,
		configJson: canonicalRunConfigJson(input.config),
		createdAt: input.now,
	};
	db.insert(runConfigs).values(row).run();
	return row;
}

export interface BackfillRunConfigsOptions {
	now?: () => string;
}

/**
 * Assign a group to every replay that carries a `run_config` but no hash —
 * i.e. every replay created before run configs had an identity. Returns the
 * number of replays grouped.
 *
 * This can't live in the migration SQL: SQLite has no SHA-256, so the hash has
 * to be computed in application code. Called once at startup, idempotent, so a
 * restart after a partial run finishes the job.
 *
 * Legacy groups come out unnamed — the label was never sent, so there is
 * nothing to recover. A corrupt `run_config_json` is skipped with a warning
 * rather than aborting: one unparseable row must not stop the server from
 * booting. Same degrade-don't-throw stance as `parseStoredSpec`.
 */
export function backfillRunConfigs(store: Store, opts: BackfillRunConfigsOptions = {}): number {
	const now = opts.now ?? (() => new Date().toISOString());
	const pending = store.db
		.select({ id: replays.id, runConfigJson: replays.runConfigJson })
		.from(replays)
		.where(and(isNotNull(replays.runConfigJson), isNull(replays.runConfigHash)))
		.all();

	const grouped: string[] = [];
	store.db.transaction((tx) => {
		for (const row of pending) {
			const config = parseLegacyRunConfig(row.id, row.runConfigJson);
			if (config === undefined) continue;
			const group = ensureRunConfig(tx, { config, now: now() });
			tx.update(replays).set({ runConfigHash: group.hash }).where(eq(replays.id, row.id)).run();
			grouped.push(row.id);
		}
	});
	return grouped.length;
}

/**
 * `undefined` means "this replay gets no group": either the column was null,
 * held an explicit JSON `null` (treated the same as absent, matching
 * `POST /v1/replays`), or could not be parsed.
 */
function parseLegacyRunConfig(replayId: string, raw: string | null): unknown {
	if (raw === null) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null) return undefined;
		// Canonicalize eagerly so a value the encoder rejects is caught here,
		// where it degrades to a skip, rather than inside the transaction.
		canonicalRunConfigJson(parsed);
		return parsed;
	} catch (err) {
		console.warn(
			"[run-configs] skipping backfill for replay=%s: run_config_json is not canonicalizable. err=%s",
			replayId,
			err instanceof Error ? err.message : String(err),
		);
		return undefined;
	}
}
