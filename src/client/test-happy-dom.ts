import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Register happy-dom for a single React-rendering test file. Idempotent — the
 * guard tolerates multiple test files in the same `bun test` run registering
 * "first". `url` is set so any component constructing absolute URLs from
 * `window.location.origin` gets a real origin instead of "null".
 *
 * Call this BEFORE dynamic-importing `@testing-library/react` and the
 * component under test — those modules read `document` at load.
 */
export function registerHappyDom(): void {
	if (!GlobalRegistrator.isRegistered) {
		GlobalRegistrator.register({ url: "http://localhost" });
	}
}
