import { Hono } from "hono";

export const healthz = new Hono();

healthz.get("/", (c) => c.json({ ok: true }));
