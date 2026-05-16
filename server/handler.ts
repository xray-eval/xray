export function handleRequest(request: Request): Response {
	const url = new URL(request.url);
	if (url.pathname === "/healthz") {
		return Response.json({ ok: true });
	}
	return new Response("Not found", { status: 404 });
}
