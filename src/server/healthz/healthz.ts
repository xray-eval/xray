import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

import { OkResponseSchema, openApiSchemaFromValibot } from "@/server/core/types.ts";

export const healthz = new Hono();

healthz.get(
	"/",
	describeRoute({
		tags: ["Health"],
		summary: "Liveness probe",
		description: "Always returns `{ok: true}`. Used by `docker:smoke` and container orchestration.",
		responses: {
			"200": {
				description: "Process is up.",
				content: { "application/json": { schema: openApiSchemaFromValibot(OkResponseSchema) } },
			},
		},
	}),
	(c) => c.json({ ok: true }),
);
