import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { ConfigPicker } = await import("./config-picker.tsx");
const { splitConfigFacets } = await import("./config-facets.ts");
const { makeRunConfigSummary } = await import("./test-utils.ts");

afterEach(() => cleanup());

const A = "a".repeat(64);
const B = "b".repeat(64);

const ITEMS = [
	makeRunConfigSummary({ hash: A, name: "baseline" }),
	makeRunConfigSummary({
		hash: B,
		name: "fresh",
		coverage: { conversations: 0, replays: 0, failed_replays: 0 },
	}),
];

function picker(
	selected: readonly string[] = [],
	onToggle: (hash: string) => void = () => undefined,
) {
	return (
		<ConfigPicker
			items={ITEMS}
			facets={splitConfigFacets(ITEMS)}
			selected={selected}
			onToggle={onToggle}
		/>
	);
}

describe("ConfigPicker", () => {
	it("stays collapsed until asked, so the comparison keeps the page", () => {
		render(picker());
		expect(screen.queryByLabelText("Filter configs")).toBeNull();
	});

	it("says how many configs there are to choose between", () => {
		render(picker());
		// The ran/total split is the part worth surfacing before opening: it says
		// how much of the list can actually contribute a column.
		expect(screen.getByRole("button", { name: "Choose configs to compare" }).textContent).toContain(
			"1 ran · 2 total",
		);
	});

	it("opens the chooser on click", () => {
		render(picker());
		fireEvent.click(screen.getByRole("button", { name: "Choose configs to compare" }));

		expect(screen.getByLabelText("Filter configs")).toBeDefined();
		expect(screen.getByRole("button", { name: /baseline/ })).toBeDefined();
	});

	it("reports a config chosen from the open list", () => {
		const toggled: string[] = [];
		render(picker([], (hash) => toggled.push(hash)));
		fireEvent.click(screen.getByRole("button", { name: "Choose configs to compare" }));
		fireEvent.click(screen.getByRole("button", { name: /baseline/ }));

		expect(toggled).toEqual([A]);
	});
});
