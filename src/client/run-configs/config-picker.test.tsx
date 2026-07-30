import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { ConfigPicker } = await import("./config-picker.tsx");
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

describe("ConfigPicker", () => {
	it("reports each card's selected state and what it spans", () => {
		const [a, b] = hashes(2);
		if (a === undefined || b === undefined) throw new Error("fixture is empty");
		render(
			<ConfigPicker
				items={[
					makeRunConfigSummary({ hash: a, name: "baseline" }),
					makeRunConfigSummary({
						hash: b,
						name: "fast-follow",
						coverage: { conversations: 3, replays: 5, failed_replays: 2 },
					}),
				]}
				selected={[a]}
				onToggle={() => undefined}
			/>,
		);
		expect(screen.getByRole("button", { name: /baseline/ }).getAttribute("aria-pressed")).toBe(
			"true",
		);
		const fast = screen.getByRole("button", { name: /fast-follow/ });
		expect(fast.getAttribute("aria-pressed")).toBe("false");
		expect(fast.textContent).toContain("3 conversations · 5 replays · 2 failed");
	});

	it("reports the card the user clicked", () => {
		const [a, b] = hashes(2);
		if (a === undefined || b === undefined) throw new Error("fixture is empty");
		const toggled: string[] = [];
		render(
			<ConfigPicker
				items={[
					makeRunConfigSummary({ hash: a, name: "baseline" }),
					makeRunConfigSummary({ hash: b, name: "fast-follow" }),
				]}
				selected={[a]}
				onToggle={(hash) => toggled.push(hash)}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /fast-follow/ }));
		expect(toggled).toEqual([b]);
	});

	it("explains the cap instead of just greying every remaining card out", () => {
		const all = hashes(9);
		const items = all.map((hash, i) => makeRunConfigSummary({ hash, name: `config-${i + 1}` }));
		render(<ConfigPicker items={items} selected={all.slice(0, 8)} onToggle={() => undefined} />);

		const unselected = screen.getByRole("button", { name: /config-9/ });
		expect(unselected.hasAttribute("disabled")).toBe(true);
		expect(screen.getByRole("status").textContent).toContain("maximum of 8 configs");
	});

	it("leaves selected cards clickable at the cap, so the picker never locks up", () => {
		const all = hashes(9);
		const items = all.map((hash, i) => makeRunConfigSummary({ hash, name: `config-${i + 1}` }));
		render(<ConfigPicker items={items} selected={all.slice(0, 8)} onToggle={() => undefined} />);

		expect(screen.getByRole("button", { name: /config-1/ }).hasAttribute("disabled")).toBe(false);
	});
});
