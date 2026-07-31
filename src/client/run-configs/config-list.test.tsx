import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { ConfigList } = await import("./config-list.tsx");
const { splitConfigFacets } = await import("./config-facets.ts");
const { makeRunConfigSummary } = await import("./test-utils.ts");

afterEach(() => cleanup());

/** `count` distinct sha256-shaped hashes, stable across calls. */
function hashes(count: number): string[] {
	return Array.from({ length: count }, (_, i) =>
		String(i + 1)
			.repeat(64)
			.slice(0, 64),
	);
}

type Summary = ReturnType<typeof makeRunConfigSummary>;

function list(
	items: readonly Summary[],
	selected: readonly string[],
	onToggle: (hash: string) => void = () => undefined,
) {
	return (
		<ConfigList
			items={items}
			facets={splitConfigFacets(items)}
			selected={selected}
			onToggle={onToggle}
		/>
	);
}

describe("ConfigList", () => {
	it("reports each row's selected state and what it spans", () => {
		const [a, b] = hashes(2);
		if (a === undefined || b === undefined) throw new Error("fixture is empty");
		const items = [
			makeRunConfigSummary({ hash: a, name: "baseline" }),
			makeRunConfigSummary({
				hash: b,
				name: "fast-follow",
				coverage: { conversations: 3, replays: 5, failed_replays: 2 },
			}),
		];
		render(list(items, [a]));

		expect(screen.getByRole("button", { name: /baseline/ }).getAttribute("aria-pressed")).toBe(
			"true",
		);
		const fast = screen.getByRole("button", { name: /fast-follow/ });
		expect(fast.getAttribute("aria-pressed")).toBe("false");
		expect(fast.textContent).toContain("3 conversations · 5 replays");
		expect(fast.textContent).toContain("2 failed");
	});

	it("reports the row the user clicked", () => {
		const [a, b] = hashes(2);
		if (a === undefined || b === undefined) throw new Error("fixture is empty");
		const toggled: string[] = [];
		const items = [
			makeRunConfigSummary({ hash: a, name: "baseline" }),
			makeRunConfigSummary({ hash: b, name: "fast-follow" }),
		];
		render(list(items, [a], (hash) => toggled.push(hash)));

		fireEvent.click(screen.getByRole("button", { name: /fast-follow/ }));
		expect(toggled).toEqual([b]);
	});

	it("explains the cap instead of just greying every remaining row out", () => {
		const all = hashes(9);
		const items = all.map((hash, i) => makeRunConfigSummary({ hash, name: `config-${i + 1}` }));
		render(list(items, all.slice(0, 8)));

		expect(screen.getByRole("button", { name: /config-9/ }).hasAttribute("disabled")).toBe(true);
		expect(screen.getByRole("status").textContent).toContain("maximum of 8 configs");
	});

	it("leaves selected rows clickable at the cap, so the picker never locks up", () => {
		const all = hashes(9);
		const items = all.map((hash, i) => makeRunConfigSummary({ hash, name: `config-${i + 1}` }));
		render(list(items, all.slice(0, 8)));

		expect(screen.getByRole("button", { name: /config-1/ }).hasAttribute("disabled")).toBe(false);
	});

	it("states what every config shares once, instead of on every row", () => {
		const [a, b] = hashes(2);
		if (a === undefined || b === undefined) throw new Error("fixture is empty");
		const items = [
			makeRunConfigSummary({ hash: a, name: null, config: { model: "gpt-5", turn: "one" } }),
			makeRunConfigSummary({ hash: b, name: null, config: { model: "gpt-5", turn: "two" } }),
		];
		render(list(items, []));

		const shared = screen.getByTestId("shared-facets");
		expect(shared.textContent).toContain("model");
		expect(shared.textContent).toContain("gpt-5");
	});

	it("omits the shared strip when the configs have nothing in common", () => {
		const [a, b] = hashes(2);
		if (a === undefined || b === undefined) throw new Error("fixture is empty");
		const items = [
			makeRunConfigSummary({ hash: a, name: null, config: { model: "gpt-5" } }),
			makeRunConfigSummary({ hash: b, name: null, config: { model: "claude" } }),
		];
		render(list(items, []));

		expect(screen.queryByTestId("shared-facets")).toBeNull();
	});

	it("filters the list as the user types", () => {
		const [a, b] = hashes(2);
		if (a === undefined || b === undefined) throw new Error("fixture is empty");
		const items = [
			makeRunConfigSummary({ hash: a, name: "baseline" }),
			makeRunConfigSummary({ hash: b, name: "fast-follow" }),
		];
		render(list(items, []));

		fireEvent.change(screen.getByLabelText("Filter configs"), { target: { value: "fast" } });

		expect(screen.queryByRole("button", { name: /baseline/ })).toBeNull();
		expect(screen.getByRole("button", { name: /fast-follow/ })).toBeDefined();
	});

	it("says so when a query matches nothing, rather than showing a blank pane", () => {
		const [a] = hashes(1);
		if (a === undefined) throw new Error("fixture is empty");
		render(list([makeRunConfigSummary({ hash: a, name: "baseline" })], []));

		fireEvent.change(screen.getByLabelText("Filter configs"), { target: { value: "zzz" } });

		expect(screen.getByText(/No configs match/)).toBeDefined();
	});

	it("keeps never-run configs out of the way until asked for", () => {
		const [a, b] = hashes(2);
		if (a === undefined || b === undefined) throw new Error("fixture is empty");
		const items = [
			makeRunConfigSummary({ hash: a, name: "baseline" }),
			makeRunConfigSummary({
				hash: b,
				name: "fresh",
				coverage: { conversations: 0, replays: 0, failed_replays: 0 },
			}),
		];
		render(list(items, []));

		expect(screen.queryByRole("button", { name: /fresh/ })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /Never run \(1\)/ }));
		expect(screen.getByRole("button", { name: /fresh/ })).toBeDefined();
	});

	it("reports the never-run disclosure's open state to assistive tech", () => {
		const [a, b] = hashes(2);
		if (a === undefined || b === undefined) throw new Error("fixture is empty");
		const items = [
			makeRunConfigSummary({ hash: a, name: "baseline" }),
			makeRunConfigSummary({
				hash: b,
				name: "fresh",
				coverage: { conversations: 0, replays: 0, failed_replays: 0 },
			}),
		];
		render(list(items, []));

		const toggle = screen.getByRole("button", { name: /Never run/ });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
	});

	it("surfaces a never-run config the query matched, instead of leaving it collapsed", () => {
		// Searching for something by name and being shown nothing reads as "no
		// such config", not "it's behind a disclosure you didn't open".
		const [a, b] = hashes(2);
		if (a === undefined || b === undefined) throw new Error("fixture is empty");
		const items = [
			makeRunConfigSummary({ hash: a, name: "probe-active" }),
			makeRunConfigSummary({
				hash: b,
				name: "probe-fresh",
				coverage: { conversations: 0, replays: 0, failed_replays: 0 },
			}),
		];
		render(list(items, []));

		expect(screen.queryByRole("button", { name: /probe-fresh/ })).toBeNull();
		fireEvent.change(screen.getByLabelText("Filter configs"), { target: { value: "probe" } });

		expect(screen.getByRole("button", { name: /probe-fresh/ })).toBeDefined();
	});

	it("shows never-run configs outright when there is nothing else to show", () => {
		// Collapsing them here would hide the page's only content behind a
		// disclosure and leave a blank pane.
		const [a, b] = hashes(2);
		if (a === undefined || b === undefined) throw new Error("fixture is empty");
		const items = [a, b].map((hash, i) =>
			makeRunConfigSummary({
				hash,
				name: `fresh-${i + 1}`,
				coverage: { conversations: 0, replays: 0, failed_replays: 0 },
			}),
		);
		render(list(items, []));

		expect(screen.getByRole("button", { name: /fresh-1/ })).toBeDefined();
		expect(screen.queryByRole("button", { name: /Never run \(/ })).toBeNull();
	});

	it("does not offer a never-run section when every config has run", () => {
		const [a] = hashes(1);
		if (a === undefined) throw new Error("fixture is empty");
		render(list([makeRunConfigSummary({ hash: a, name: "baseline" })], []));

		expect(screen.queryByRole("button", { name: /Never run/ })).toBeNull();
	});
});
