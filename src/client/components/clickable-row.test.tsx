import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it, mock } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { ClickableRow } = await import("./clickable-row.tsx");
const { Table, TableBody, TableCell } = await import("./ui/table.tsx");

afterEach(() => cleanup());

function renderRow(props: {
	selected: boolean;
	onToggle: () => void;
	onOpen: () => void;
	selectLabel: string;
}) {
	return render(
		<Table>
			<TableBody>
				<ClickableRow {...props}>
					<TableCell>cell-content</TableCell>
				</ClickableRow>
			</TableBody>
		</Table>,
	);
}

describe("ClickableRow", () => {
	it("calls onOpen when the row body is clicked", () => {
		const onOpen = mock();
		const onToggle = mock();
		renderRow({ selected: false, onOpen, onToggle, selectLabel: "select" });
		fireEvent.click(screen.getByText("cell-content"));
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(onToggle).not.toHaveBeenCalled();
	});

	it("calls onToggle (not onOpen) when the checkbox is clicked", () => {
		const onOpen = mock();
		const onToggle = mock();
		renderRow({ selected: false, onOpen, onToggle, selectLabel: "select-me" });
		fireEvent.click(screen.getByRole("checkbox", { name: "select-me" }));
		expect(onToggle).toHaveBeenCalledTimes(1);
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("does NOT set role=link on the <tr> (preserves native table semantics)", () => {
		const noop = mock();
		const { container } = renderRow({
			selected: false,
			onOpen: noop,
			onToggle: noop,
			selectLabel: "x",
		});
		const tr = container.querySelector("tr");
		expect(tr?.getAttribute("role")).toBeNull();
		expect(tr?.getAttribute("tabindex")).toBeNull();
	});

	it('reflects selection via data-state="selected"', () => {
		const noop = mock();
		const { container } = renderRow({
			selected: true,
			onOpen: noop,
			onToggle: noop,
			selectLabel: "x",
		});
		expect(container.querySelector("tr")?.getAttribute("data-state")).toBe("selected");
	});
});
