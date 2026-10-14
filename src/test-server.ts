import type { HttpRequestEventMap, Interceptor } from "@mswjs/interceptors";
import { FetchInterceptor } from "@mswjs/interceptors/fetch/web";
import { defineNetwork, InterceptorSource } from "msw/experimental";

import { IncompatibleInterceptorError } from "@/test-server.errors.ts";

/**
 * `InterceptorSource`'s declarations reference the Node build of
 * `@mswjs/interceptors`, while the web `FetchInterceptor` ships in its browser
 * build — two declarations of the same `Interceptor` class, which TypeScript
 * treats as unrelated because of its `#private` fields. At runtime the source
 * only drives the interceptor through these three methods, so check exactly
 * those instead of asserting the type.
 */
function isInterceptorSourceCompatible(
	interceptor: object,
): interceptor is Interceptor<HttpRequestEventMap> {
	return (
		"apply" in interceptor &&
		typeof interceptor.apply === "function" &&
		"dispose" in interceptor &&
		typeof interceptor.dispose === "function" &&
		"on" in interceptor &&
		typeof interceptor.on === "function"
	);
}

const fetchInterceptor = new FetchInterceptor();
if (!isInterceptorSourceCompatible(fetchInterceptor)) {
	throw new IncompatibleInterceptorError("FetchInterceptor");
}

/**
 * Shared MSW network. Empty at startup — every test registers its own
 * handlers via `server.use(...)`. Lifecycle hooks (enable/reset/disable) live
 * in `bun-test-setup.ts` at the project root (preloaded via bunfig.toml);
 * tests only import this singleton.
 *
 * Not `setupServer()` from `msw/node`: since msw 3 that intercepts at the
 * `node:net` socket layer, and Bun's native `fetch` never goes through
 * `node:net`, so every request would silently reach the real network. The
 * web `FetchInterceptor` patches `globalThis.fetch` itself — the setup msw's
 * maintainers recommend for runtimes that don't mirror Node internals
 * (mswjs/msw#2811).
 *
 * `onUnhandledFrame: "error"` means any real network call from production
 * code under test fails loudly — there is no implicit pass-through
 * (`src/test-server.test.ts` holds that guarantee).
 */
export const server = defineNetwork({
	sources: [new InterceptorSource({ interceptors: [fetchInterceptor] })],
	handlers: [],
	onUnhandledFrame: "error",
});
