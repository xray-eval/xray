import type { Hono } from "hono";
import { generateSpecs } from "hono-openapi";

const TITLE = "xray HTTP API";
const VERSION = "0.0.0";

const DESCRIPTION = `Open-source replay/eval framework for LiveKit voice agents.

Three surface areas:

- **Control plane** — \`POST /v1/conversations\` (the dev's test definition) and \`POST /v1/replays\` (one execution). The SDK calls these *before* the agent runs so spans coming through OTLP route correctly.
- **OTLP/HTTP receiver** — \`POST /v1/otlp/v1/traces\` ingests OpenTelemetry trace spans. It **filters, not gates** — spans whose vocabulary it doesn't recognize (or whose \`xray.replay.id\` doesn't exist) are silently dropped. See \`docs/WIRE.md\` for recognized vocabularies (xray.*, OTel GenAI semconv \`gen_ai.*\`, Langfuse).
- **Audio** — per-turn and full-replay audio bytes live next to \`xray.db\` on the mounted volume.

xray ships as a single Docker image with a single SQLite file. The SDK→xray surface has no auth; do not expose port 8080 publicly — see \`README.md\`.`;

/**
 * Build the OpenAPI 3.1 document. Routes contribute their own metadata via
 * `describeRoute(...)` in each router; this function adds the top-level
 * `info` and `servers` sections.
 */
export async function buildOpenApiDoc(app: Hono): Promise<unknown> {
	const spec = await generateSpecs(app, {
		documentation: {
			openapi: "3.1.0",
			info: {
				title: TITLE,
				version: VERSION,
				description: DESCRIPTION,
				license: {
					name: "Elastic License 2.0",
					url: "https://www.elastic.co/licensing/elastic-license",
				},
			},
		},
	});
	return spec;
}
