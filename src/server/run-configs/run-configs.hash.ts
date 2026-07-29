import { createHash } from "node:crypto";

/**
 * Canonical-JSON encode a run config: object keys sorted at every depth,
 * array order preserved, no whitespace. Two configs with the same content
 * encode to the same string regardless of how the SDK ordered its keys.
 *
 * Throws `TypeError` on values JSON cannot represent (NaN, ±Infinity, bigint,
 * functions). Those can't survive `JSON.parse` at the wire boundary, so this
 * only fires for a caller passing a hand-built object.
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
			throw new TypeError("Cannot canonicalize NaN or +/-Infinity in a run config");
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
	throw new TypeError(`Cannot canonicalize run config value of type ${typeof value}`);
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
