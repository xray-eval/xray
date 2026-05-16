import { handleRequest } from "./handler.ts";

const port = Number(process.env["PORT"] ?? 8080);
const hostname = process.env["HOST"] ?? "0.0.0.0";

const server = Bun.serve({
	port,
	hostname,
	fetch: handleRequest,
});

console.info(`xray listening on ${server.hostname}:${server.port}`);
