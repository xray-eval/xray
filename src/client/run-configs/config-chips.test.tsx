import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { ConfigChips } = await import("./config-chips.tsx");
const { makeRunConfigGroupResult, makeRunConfigMetrics } = await import("./test-utils.ts");

afterEach(() => cleanup());

const A = "a".repeat(64);
const B = "b".repeat(64);

const GROUPS = [
	makeRunConfigGroupResult({
		hash: A,
		name: "baseline",
		coverage: { conversations: 3, replays: 4, failed_replays: 1 },
		metrics: makeRunConfigMetrics({
			pass: { passed: 3, total: 4 },
			assertions: { passed: 15, total: 20 },
			judges: { passed: 2, total: 4 },
			agent_response_ms: { avg: 820, p50: 800, p95: 1200, n: 12 },
		}),
	}),
	makeRunConfigGroupResult({
		hash: B,
		name: "fast-follow",
		coverage: { conversations: 3, replays: 3, failed_replays: 0 },
		metrics: makeRunConfigMetrics({ pass: { passed: 3, total: 3 } }),
	}),
];

describe("ConfigChips", () => {
	it("carries each config's headline numbers, so the row is readable without the grids", () => {
		render(<ConfigChips groups={GROUPS} onRemove={() => undefined} />);

		const baseline = screen.getByRole("listitem", { name: /baseline/ });
		// Judge and assertion rates side by side: a config can pass every
		// deterministic check and still be judged wrong, and the pair is what
		// says which kind of failure this is.
		expect(baseline.textContent).toContain("50%");
		expect(baseline.textContent).toContain("75%");
		expect(baseline.textContent).toContain("800ms");
	});

	it("reports how many replays a number rests on", () => {
		render(<ConfigChips groups={GROUPS} onRemove={() => undefined} />);
		expect(screen.getByRole("listitem", { name: /baseline/ }).textContent).toContain("4");
	});

	it("flags a config with failed replays, which the pass rate alone hides", () => {
		render(<ConfigChips groups={GROUPS} onRemove={() => undefined} />);

		expect(screen.getByRole("listitem", { name: /baseline/ }).textContent).toContain("1 failed");
		expect(screen.getByRole("listitem", { name: /fast-follow/ }).textContent).not.toContain(
			"failed",
		);
	});

	it("reports the config the user dropped", () => {
		const removed: string[] = [];
		render(<ConfigChips groups={GROUPS} onRemove={(hash) => removed.push(hash)} />);
		fireEvent.click(screen.getByRole("button", { name: "Remove baseline from comparison" }));

		expect(removed).toEqual([A]);
	});

	it("renders nothing when nothing is selected", () => {
		const { container } = render(<ConfigChips groups={[]} onRemove={() => undefined} />);
		expect(container.textContent).toBe("");
	});
});
