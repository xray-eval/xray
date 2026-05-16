import { Hono } from "hono";

import { healthz } from "./healthz/healthz.ts";

export const app = new Hono();

app.route("/healthz", healthz);
