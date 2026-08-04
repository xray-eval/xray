/**
 * The checks that make the committed fixture self-policing.
 *
 * A regeneration that quietly stopped populating something is the failure this
 * fixture exists to prevent, so every one of these throws rather than letting
 * `seed:snapshot` write a hollow snapshot and exit 0. Kept out of
 * `seed-snapshot.ts` so they can be tested without running the seeder — that
 * file ends in a top-level `await main()`.
 */

import { eq } from "drizzle-orm";

import {
	assertionResults,
	modelUsage,
	replayEvaluations,
	spans,
	toolCalls,
} from "@/server/store/schema.ts";
import type { StoreDb } from "@/server/store/store.ts";

/** What one replay's trace should have left behind once the receiver ran. */
export interface ExtractionExpectation {
	readonly replayId: string;
	readonly spans: number;
	readonly modelUsage: number;
	readonly toolCalls: number;
}

/**
 * The span-count check at ingest proves the vocabulary registry still recognizes
 * what we emit, but not that it still *extracts* anything: the GenAI matcher
 * keys on `gen_ai.operation.name`, so a regression in the token or tool-name
 * keys leaves a recognized span with an empty row beside it. Nothing downstream
 * notices — `tool_called` covers the tool path, and no assertion looks at model
 * usage at all, so the inspector's token bars would silently go empty.
 */
export function assertExtractedRows(db: StoreDb, expected: ExtractionExpectation): void {
	const { replayId } = expected;
	const counts = {
		spans: db.select().from(spans).where(eq(spans.replayId, replayId)).all().length,
		toolCalls: db.select().from(toolCalls).where(eq(toolCalls.replayId, replayId)).all().length,
		modelUsage: db.select().from(modelUsage).where(eq(modelUsage.replayId, replayId)).all().length,
	};
	for (const key of ["spans", "toolCalls", "modelUsage"] as const) {
		if (counts[key] !== expected[key]) {
			throw new Error(
				`seed-snapshot: ${replayId} has ${counts[key]} ${key} rows, expected ${expected[key]}`,
			);
		}
	}

	const usage = db.select().from(modelUsage).where(eq(modelUsage.replayId, replayId)).all();
	const hollow = usage.filter(
		(row) => row.inputTokens === null || row.outputTokens === null || row.ttftMs === null,
	);
	if (hollow.length > 0) {
		throw new Error(
			`seed-snapshot: ${replayId} has ${hollow.length} model_usage rows with null tokens or ttft`,
		);
	}
}

/**
 * The declared count is checked alongside the statuses because "no failing
 * rows" is trivially true when a regression stops writing rows at all.
 */
export function assertReplayIsGreen(
	db: StoreDb,
	replayId: string,
	declaredAssertions: number,
): void {
	const outcomes = db
		.select()
		.from(assertionResults)
		.where(eq(assertionResults.replayId, replayId))
		.all();
	if (outcomes.length !== declaredAssertions) {
		throw new Error(
			`seed-snapshot: ${replayId} evaluated ${outcomes.length} assertions, expected ${declaredAssertions}`,
		);
	}
	const notPassed = outcomes.filter((row) => row.status !== "passed");
	if (notPassed.length > 0) {
		const detail = notPassed
			.map(
				(row) => `turn ${row.turnIdx} ${row.kind}=${row.status} (${row.message ?? "no message"})`,
			)
			.join("; ");
		throw new Error(`seed-snapshot: ${replayId} has non-passing assertions — ${detail}`);
	}
	const evaluation = db
		.select()
		.from(replayEvaluations)
		.where(eq(replayEvaluations.replayId, replayId))
		.get();
	if (evaluation?.passed !== true) {
		throw new Error(
			`seed-snapshot: ${replayId} verdict is ${String(evaluation?.passed)}, expected passed`,
		);
	}
}
