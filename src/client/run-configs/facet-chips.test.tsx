import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen } = await import("@testing-library/react");
const { FacetChips } = await import("./facet-chips.tsx");

afterEach(() => cleanup());

const HASH = "abc123def456".padEnd(64, "0");

describe("FacetChips", () => {
	it("renders one chip per pair, with the value kept whole", () => {
		const { container } = render(
			<FacetChips
				pairs={[
					{ key: "model", value: "gpt-5" },
					{ key: "conversation", value: "barge_in_recovery" },
				]}
				hash={HASH}
			/>,
		);
		expect(container.textContent).toContain("model");
		expect(container.textContent).toContain("gpt-5");
		expect(container.textContent).toContain("barge_in_recovery");
	});

	it("falls back to the hash prefix when there are no pairs to show", () => {
		// A config that isn't an object has no pairs, and a row with no label at
		// all would be unidentifiable.
		render(<FacetChips pairs={[]} hash={HASH} />);
		expect(screen.getByText("abc123def456")).toBeDefined();
	});

	it("does not show the hash once there is a pair to show instead", () => {
		const { container } = render(
			<FacetChips pairs={[{ key: "model", value: "gpt-5" }]} hash={HASH} />,
		);
		expect(container.textContent).not.toContain("abc123def456");
	});
});
