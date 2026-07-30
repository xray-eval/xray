import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { ModeToggle } = await import("./mode-toggle.tsx");

afterEach(() => cleanup());

const OPTIONS = [
	{ value: "latest", label: "Latest per conversation" },
	{ value: "all", label: "All completed" },
] as const;

describe("ModeToggle", () => {
	it("marks only the active option as pressed", () => {
		render(
			<ModeToggle label="Replays" value="latest" options={OPTIONS} onChange={() => undefined} />,
		);
		expect(
			screen.getByRole("button", { name: "Latest per conversation" }).getAttribute("aria-pressed"),
		).toBe("true");
		expect(screen.getByRole("button", { name: "All completed" }).getAttribute("aria-pressed")).toBe(
			"false",
		);
	});

	it("reports the option the user picked", () => {
		const picked: string[] = [];
		render(
			<ModeToggle
				label="Replays"
				value="latest"
				options={OPTIONS}
				onChange={(next) => picked.push(next)}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "All completed" }));
		expect(picked).toEqual(["all"]);
	});

	it("names the group for assistive tech without repeating it visually", () => {
		render(
			<ModeToggle label="Replays" value="latest" options={OPTIONS} onChange={() => undefined} />,
		);
		// The legend carries the name; the styled copy of the same word is
		// aria-hidden so screen readers hear it once, not twice.
		expect(screen.getByRole("group", { name: "Replays" })).toBeTruthy();
	});
});
