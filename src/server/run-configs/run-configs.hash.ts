import { createHash } from "node:crypto";

import { UnhashableRunConfigError } from "./run-configs.errors.ts";

/**
 * Canonical-JSON encode a run config: object keys sorted at every depth,
 * array order preserved, no whitespace. Two configs with the same content
 * encode to the same string regardless of how the SDK ordered its keys.
 *
 * Throws `UnhashableRunConfigError` on values JSON cannot represent (NaN,
 * ±Infinity, bigint, functions). `1e999` is valid JSON that parses to
 * Infinity and `run_config` is `v.unknown()`, so this is reachable from the
 * wire — it's a typed error rather than a `TypeError` so the route answers
 * 400 instead of falling through to the 500 catch-all.
 *
 * Deliberately NOT `canonicalStringify` from
 * `@/server/conversations/conversations.service.ts`, which rejects
 * non-integer numbers and escapes non-ASCII. That encoder is pinned to match
 * Python's `json.dumps(ensure_ascii=True)` because a conversation hash must
 * be reproducible across both runtimes — and its float rejection is a
 * load-bearing guard on the stability of every stored conversation hash.
 * Neither constraint applies here: run configs are hashed only by this
 * server, from `JSON.parse` output, and `temperature: 0.5` is the most
 * common run config in our own docs. Merging the two behind a "number
 * policy" flag was considered and rejected — it would make flipping the
 * conversation call site to float-tolerant a one-word change, which would
 * silently fork conversation identity.
 */
export function canonicalRunConfigJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new UnhashableRunConfigError(Number.isNaN(value) ? "NaN" : "±Infinity");
		}
		// JSON.stringify(-0) is already "0", so the two spellings collapse onto
		// one identity without a special case.
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalRunConfigJson).join(",")}]`;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const parts = entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalRunConfigJson(val)}`);
		return `{${parts.join(",")}}`;
	}
	throw new UnhashableRunConfigError(typeof value);
}

/**
 * Identity of a run-config group: 64-char lowercase hex SHA-256 over the
 * canonical encoding. Server-only — the SDK never hashes anything, same trust
 * split as conversation hashes.
 *
 * Synchronous (`node:crypto`) rather than `crypto.subtle` so `createReplay`
 * stays synchronous and can hash inside the same transaction that inserts
 * the replay row.
 */
export function hashRunConfig(value: unknown): string {
	return createHash("sha256").update(canonicalRunConfigJson(value), "utf8").digest("hex");
}
