import {
	CompareSearchSchema,
	ConfigDetailSearchSchema,
	ConfigsSearchSchema,
	compareConversationsRoute,
	compareReplaysRoute,
	runConfigDetailRoute,
	runConfigsRoute,
} from "./router.ts";
import { describe, expect, test } from "bun:test";

/**
 * router-core merges a validator's output *over* the raw search
 * (`preMatchSearch = { ...parentSearch, ...strictSearch }`), so rejecting a
 * value by omitting it from the output leaves the raw one in place. Every
 * assertion below goes through that merge, because that — not the validator's
 * return value on its own — is what `useSearch` hands the page.
 */
function afterMerge(
	route: { options: { validateSearch?: unknown } },
	raw: Record<string, unknown>,
): Record<string, unknown> {
	const validate = route.options.validateSearch;
	if (typeof validate !== "function") throw new Error("route has no validateSearch");
	return { ...raw, ...validate(raw) };
}

describe("/configs search", () => {
	test("keeps valid params", () => {
		expect(
			afterMerge(runConfigsRoute, { ids: "a,b", replays: "all", scope: "intersection" }),
		).toEqual({ ids: "a,b", replays: "all", scope: "intersection" });
	});

	test("drops an unknown scope instead of forwarding it to the API", () => {
		expect(afterMerge(runConfigsRoute, { scope: "bogus" })).toEqual({});
	});

	test("drops an unknown replay selection", () => {
		expect(afterMerge(runConfigsRoute, { replays: "nonsense" })).toEqual({});
	});

	test("drops a non-string ids", () => {
		// TanStack JSON-parses every search value, so `?ids=123` arrives as a
		// number. Left in place it reaches `resolveSelection`, which calls
		// `.trim()` on it — a render crash, not a degraded page.
		expect(afterMerge(runConfigsRoute, { ids: 123 })).toEqual({});
	});

	test("leaves absent params absent, so links don't grow default query strings", () => {
		expect(afterMerge(runConfigsRoute, {})).toEqual({});
	});
});

describe("/configs/$configHash search", () => {
	test("keeps a valid replay selection", () => {
		expect(afterMerge(runConfigDetailRoute, { replays: "all" })).toEqual({ replays: "all" });
	});

	test("drops an unknown replay selection", () => {
		expect(afterMerge(runConfigDetailRoute, { replays: "nonsense" })).toEqual({});
	});
});

describe("/compare/replays search", () => {
	test("drops a non-string ids", () => {
		expect(afterMerge(compareReplaysRoute, { ids: 123 })).toEqual({});
	});
});

/**
 * The validators call `v.parse`, which is only safe while every field falls
 * back instead of failing. The junk search is built from each schema's own keys
 * rather than a hand-written list, so a field added without `urlParam` fails
 * here whatever it's called — a hard-coded payload would simply not carry the
 * new key, and the throw would land on whoever opened a stale link instead.
 */
describe("search validators are total", () => {
	for (const [name, route, schema] of [
		["/configs", runConfigsRoute, ConfigsSearchSchema],
		["/configs/$configHash", runConfigDetailRoute, ConfigDetailSearchSchema],
		["/compare/replays", compareReplaysRoute, CompareSearchSchema],
		["/compare/conversations", compareConversationsRoute, CompareSearchSchema],
	] as const) {
		test(`${name} coerces a fully malformed search instead of throwing`, () => {
			const validate = route.options.validateSearch;
			if (typeof validate !== "function") throw new Error("route has no validateSearch");
			const keys = Object.keys(schema.entries);
			expect(keys.length).toBeGreaterThan(0);
			// An object matches none of the search schemas' field types, so every
			// key is a rejection whatever the field turns out to accept.
			const junk = Object.fromEntries(keys.map((key) => [key, { nope: true }]));
			const owned = validate(junk);
			expect(Object.keys(owned).sort()).toEqual(keys.sort());
			for (const value of Object.values(owned)) expect(value).toBeUndefined();
		});
	}
});
