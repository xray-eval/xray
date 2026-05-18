import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import { registerHappyDom } from "./test-happy-dom.ts";
import { describe, expect, it } from "bun:test";

registerHappyDom();
const { render, screen } = await import("@testing-library/react");
const { App } = await import("./app.tsx");

describe("App", () => {
	it("renders the xray heading", async () => {
		server.use(
			http.get("http://localhost/v1/conversations", () => HttpResponse.json({ items: [] })),
		);
		render(<App />);
		expect(await screen.findByRole("heading", { name: /xray/i })).toBeTruthy();
	});
});
