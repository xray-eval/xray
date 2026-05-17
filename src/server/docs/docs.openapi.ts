import type { Hono } from "hono";
import { generateSpecs } from "hono-openapi";

import { openApiSchemaFromValibot } from "@/server/core/types.ts";
import { WebhookRequestSchema, WebhookResponseSchema } from "@/server/replays/replays.types.ts";

const TITLE = "xray HTTP API";
const VERSION = "0.0.0";

const DESCRIPTION = `Voice-agent debugger HTTP surface. Two audiences:

- **Custom-loop devs** — POST events from your voice loop to \`POST /v1/sessions/:id/events\`.
- **Replay webhook authors** — implement \`POST {webhookUrl}\` (text replay, see \`webhooks\`) or a \`ws://\`/\`wss://\` server (realtime replay, see \`/asyncapi.json\`) so xray can re-run a recorded session through your code.

The realtime-replay protocol uses framed WebSocket messages and is documented separately as AsyncAPI 3.0 at [\`/asyncapi.json\`](/asyncapi.json) — OpenAPI does not model WS message channels.`;

/**
 * Build the OpenAPI 3.1 document. Routes contribute their own metadata via
 * `describeRoute(...)` in each router; this function adds the top-level
 * `info`, `servers`, and `webhooks:` section.
 *
 * Returned as a plain object so the router can `c.json()` it. Callers MUST
 * await — assembly is async because hono-openapi resolves Valibot schemas
 * via Standard Schema's async vendor loader.
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
			// No `servers` entry: Scalar falls back to the doc's own origin, so
			// operators behind a reverse proxy (https://xray.example.com) see the
			// correct host. A hardcoded `http://localhost:8080` would make
			// Scalar's "try it out" fire cross-origin requests to localhost on
			// the operator's machine.
			webhooks: {
				textReplay: {
					post: {
						summary: "Text-replay turn callback",
						description: `xray POSTs this payload to the \`webhookUrl\` you passed to \`POST /v1/replays\`, **once per user turn** in the source session, in order. Your webhook re-runs the agent step and returns the new \`agentText\` (plus optional tool calls and latency).

The recorded original tool results are included so your webhook can satisfy in-flight tool calls without re-executing real side effects — re-issuing a refund or a calendar booking against production while debugging is rarely what you want.`,
						operationId: "textReplayWebhook",
						requestBody: {
							required: true,
							content: {
								"application/json": { schema: openApiSchemaFromValibot(WebhookRequestSchema) },
							},
						},
						responses: {
							"200": {
								description: "Webhook handled the turn and produced an agent response.",
								content: {
									"application/json": { schema: openApiSchemaFromValibot(WebhookResponseSchema) },
								},
							},
						},
					},
				},
			},
		},
	});

	return spec;
}
