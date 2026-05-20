import type { ReactNode } from "react";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen } = await import("@testing-library/react");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import(
	"@tanstack/react-router"
);
const { BackLink } = await import("./back-link.tsx");

afterEach(() => cleanup());

function renderInRouter(node: ReactNode) {
	const rootRoute = createRootRoute({ component: () => <>{node}</> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	return render(<RouterProvider router={router} />);
}

describe("BackLink", () => {
	it("renders the children inside an anchor with the back-arrow icon", async () => {
		renderInRouter(<BackLink to="/">Conversations</BackLink>);
		const link = await screen.findByRole("link", { name: /conversations/i });
		expect(link.tagName).toBe("A");
		expect(link.querySelector("svg")).not.toBeNull();
	});

	it("merges a caller-provided className with the stock styles (cn — last wins)", async () => {
		renderInRouter(
			<BackLink to="/" className="text-red-500 custom-marker">
				X
			</BackLink>,
		);
		const link = await screen.findByRole("link", { name: "X" });
		const cls = link.className;
		expect(cls).toContain("custom-marker");
		expect(cls).toContain("text-red-500");
		expect(cls).toContain("inline-flex");
	});
});
