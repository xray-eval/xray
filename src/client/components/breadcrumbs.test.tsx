import type { ReactNode } from "react";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen } = await import("@testing-library/react");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import(
	"@tanstack/react-router"
);
const { Breadcrumbs } = await import("./breadcrumbs.tsx");

afterEach(() => cleanup());

function renderInRouter(node: ReactNode) {
	const rootRoute = createRootRoute({ component: () => <>{node}</> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	return render(<RouterProvider router={router} />);
}

describe("Breadcrumbs", () => {
	it('marks the current crumb with aria-current="page" and not a link', async () => {
		renderInRouter(
			<Breadcrumbs
				crumbs={[
					{ label: "Conversations", to: "/" },
					{ label: "Title X", current: true },
				]}
			/>,
		);
		const current = await screen.findByText("Title X");
		expect(current.getAttribute("aria-current")).toBe("page");
		expect(current.tagName).toBe("SPAN");
	});

	it("renders non-current crumbs as links", async () => {
		renderInRouter(
			<Breadcrumbs
				crumbs={[
					{ label: "Conversations", to: "/" },
					{ label: "Title X", current: true },
				]}
			/>,
		);
		const link = await screen.findByRole("link", { name: "Conversations" });
		expect(link.tagName).toBe("A");
	});

	it("renders without React duplicate-key warnings when two crumbs share a label", async () => {
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			renderInRouter(
				<Breadcrumbs
					crumbs={[
						{ label: "Same", to: "/" },
						{ label: "Same", to: "/" },
						{ label: "End", current: true },
					]}
				/>,
			);
			await screen.findByText("End");
		} finally {
			console.error = originalError;
		}
		const dupeKeyWarnings = errors.filter((e) => /unique "key" prop/.test(e));
		expect(dupeKeyWarnings).toEqual([]);
	});
});
