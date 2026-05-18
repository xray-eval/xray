import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";

import { buildOpenApiDoc } from "./docs.openapi.ts";

/**
 * Mounts the API-documentation surfaces:
 *
 * - `GET /openapi.json` — OpenAPI 3.1 spec for every HTTP route.
 * - `GET /docs` — Scalar UI rendering the OpenAPI doc.
 *
 * The `app` arg is the fully-composed Hono instance — the docs router must
 * see every route in order to enumerate them. `createApp` therefore wires the
 * routers first, then attaches this router to the same instance.
 *
 * The spec is a pure function of source code — it cannot change between
 * requests in a given process. The router caches the serialized JSON body
 * on first request and replays it; Scalar's `/docs` UI re-fetches
 * `/openapi.json` on every page load, so the saving is per-page-load.
 */
export function createDocsRouter(app: Hono): Hono {
	const router = new Hono();

	let openApiJson: string | undefined;

	router.get("/openapi.json", async (c) => {
		openApiJson ??= JSON.stringify(await buildOpenApiDoc(app));
		return c.body(openApiJson, 200, { "Content-Type": "application/json" });
	});

	router.get(
		"/docs",
		Scalar({
			url: "/openapi.json",
			pageTitle: "xray API reference",
			theme: "default",
			// Pin the Scalar bundle to a specific version. Without the pin,
			// `@scalar/hono-api-reference` defaults to `latest`, which on a
			// CDN/maintainer compromise of `@scalar/api-reference` would execute
			// arbitrary JS in the operator's browser on `http://localhost:8080`
			// with read access to every recorded replay. Pinning a version
			// doesn't remove CDN trust (no SRI) but it stops `latest` from
			// drifting silently.
			cdn: "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.57.2",
		}),
	);

	return router;
}
