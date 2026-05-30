import { registerHappyDom } from "../test-happy-dom.ts";
import { SpanSelectionProvider, useSpanSelection } from "./span-selection.tsx";
import { describe, expect, it } from "bun:test";

registerHappyDom();
const { act, cleanup, render, screen } = await import("@testing-library/react");
const { afterEach } = await import("bun:test");

afterEach(() => cleanup());

function Harness() {
	const { selectedSpanId, select, clear } = useSpanSelection();
	return (
		<div>
			<output data-testid="sel">{selectedSpanId ?? "none"}</output>
			<button type="button" onClick={() => select("span-9")}>
				select
			</button>
			<button type="button" onClick={clear}>
				clear
			</button>
		</div>
	);
}

describe("useSpanSelection", () => {
	it("is inert outside a provider — select is a no-op, never throws", () => {
		render(<Harness />);
		act(() => screen.getByText("select").click());
		expect(screen.getByTestId("sel").textContent).toBe("none");
	});

	it("tracks the selected span id inside a provider", () => {
		render(
			<SpanSelectionProvider>
				<Harness />
			</SpanSelectionProvider>,
		);
		expect(screen.getByTestId("sel").textContent).toBe("none");
		act(() => screen.getByText("select").click());
		expect(screen.getByTestId("sel").textContent).toBe("span-9");
	});

	it("clears the selection", () => {
		render(
			<SpanSelectionProvider>
				<Harness />
			</SpanSelectionProvider>,
		);
		act(() => screen.getByText("select").click());
		expect(screen.getByTestId("sel").textContent).toBe("span-9");
		act(() => screen.getByText("clear").click());
		expect(screen.getByTestId("sel").textContent).toBe("none");
	});
});
