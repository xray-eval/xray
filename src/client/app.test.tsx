import { HttpResponse, http } from "msw";

import { server } from "@/test-server.ts";

import { registerHappyDom } from "./test-happy-dom.ts";
import { describe, expect, it } from "bun:test";

// happy-dom must be registered before @testing-library/react evaluates — it
// reads `document` at module load. Dynamic import preserves that ordering.
registerHappyDom();
const { render, screen } = await import("@testing-library/react");
const { App } = await import("./app.tsx");

describe("App", () => {
	it("renders the xray heading", () => {
		// App mounts <ConversationsList /> which fires GET /v1/sessions on mount.
		// MSW's onUnhandledRequest is "error", so a stub handler must exist.
		server.use(
			http.get("http://localhost/v1/sessions", () =>
				HttpResponse.json({ sessions: [], nextCursor: null }),
			),
		);
		render(<App />);
		expect(screen.getByRole("heading", { name: /xray/i })).toBeTruthy();
	});
});
