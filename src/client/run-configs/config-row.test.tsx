import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { ConfigRow } = await import("./config-row.tsx");
const { splitConfigFacets } = await import("./config-facets.ts");
const { makeRunConfigSummary } = await import("./test-utils.ts");

afterEach(() => cleanup());

const A = "a".repeat(64);
const B = "b".repeat(64);

function pairsFor(items: Parameters<typeof splitConfigFacets>[0], hash: string) {
	return splitConfigFacets(items).distinguishing.get(hash) ?? [];
}

describe("ConfigRow", () => {
	it("reports whether it is part of the comparison", () => {
		const item = makeRunConfigSummary({ hash: A, name: "baseline" });
		render(
			<ConfigRow
				item={item}
				pairs={pairsFor([item], A)}
				accentIndex={0}
				disabled={false}
				onToggle={() => undefined}
			/>,
		);
		expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("true");
	});

	it("reports what the config spans", () => {
		const item = makeRunConfigSummary({
			hash: A,
			name: "baseline",
			coverage: { conversations: 3, replays: 5, failed_replays: 2 },
		});
		render(
			<ConfigRow
				item={item}
				pairs={pairsFor([item], A)}
				accentIndex={null}
				disabled={false}
				onToggle={() => undefined}
			/>,
		);
		expect(screen.getByRole("button").textContent).toContain("3 conversations · 5 replays");
		expect(screen.getByRole("button").textContent).toContain("2 failed");
	});

	it("says a config never ran instead of reporting three zeroes", () => {
		const item = makeRunConfigSummary({
			hash: A,
			name: "fresh",
			coverage: { conversations: 0, replays: 0, failed_replays: 0 },
		});
		render(
			<ConfigRow
				item={item}
				pairs={pairsFor([item], A)}
				accentIndex={null}
				disabled={false}
				onToggle={() => undefined}
			/>,
		);
		const text = screen.getByRole("button").textContent ?? "";
		expect(text).toContain("never run");
		expect(text).not.toContain("0 conversations");
	});

	it("keeps configs that differ only past a long shared prefix distinguishable", () => {
		// The original bug: the whole config was joined into one string and cut at
		// 64 chars, which landed inside the shared prefix — so every row rendered
		// as the same text. These two exceed that length and differ only at the
		// very end.
		const items = [
			makeRunConfigSummary({
				hash: A,
				name: null,
				config: { ai_model: "openai_gpt5_6_luna", conversation: "barge_in_recovery_variant" },
			}),
			makeRunConfigSummary({
				hash: B,
				name: null,
				config: { ai_model: "openai_gpt5_6_luna", conversation: "tool_heavy_dispatch_variant" },
			}),
		];
		const [luna, terra] = items;
		if (luna === undefined || terra === undefined) throw new Error("fixture is empty");
		const { container } = render(
			<>
				<ConfigRow
					item={luna}
					pairs={pairsFor(items, A)}
					accentIndex={null}
					disabled={false}
					onToggle={() => undefined}
				/>
				<ConfigRow
					item={terra}
					pairs={pairsFor(items, B)}
					accentIndex={null}
					disabled={false}
					onToggle={() => undefined}
				/>
			</>,
		);
		const [first, second] = screen.getAllByRole("button");
		expect(first?.textContent).not.toBe(second?.textContent);
		expect(container.textContent).toContain("barge_in_recovery_variant");
		expect(container.textContent).toContain("tool_heavy_dispatch_variant");
	});

	it("reports the click", () => {
		const item = makeRunConfigSummary({ hash: A, name: "baseline" });
		const clicked: string[] = [];
		render(
			<ConfigRow
				item={item}
				pairs={pairsFor([item], A)}
				accentIndex={null}
				disabled={false}
				onToggle={(hash) => clicked.push(hash)}
			/>,
		);
		fireEvent.click(screen.getByRole("button"));
		expect(clicked).toEqual([A]);
	});

	it("cannot be clicked when the comparison is full", () => {
		const item = makeRunConfigSummary({ hash: A, name: "baseline" });
		render(
			<ConfigRow
				item={item}
				pairs={pairsFor([item], A)}
				accentIndex={null}
				disabled
				onToggle={() => undefined}
			/>,
		);
		expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
	});
});
