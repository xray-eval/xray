import type { BaseIssue, BaseSchema } from "valibot";
import * as v from "valibot";

/**
 * Tests want to assert a few field values on a JSON response. Doing it via
 * `(await res.json()) as { foo: string }` would need the banned `as` cast.
 * This helper parses the body against an inline Valibot schema, so the
 * test still asserts the shape AND we get typed access without a cast.
 */
export async function readJson<T>(
	res: Response,
	schema: BaseSchema<unknown, T, BaseIssue<unknown>>,
): Promise<T> {
	return v.parse(schema, await res.json());
}
