import { registerHappyDom } from "../test-happy-dom.ts";
import { JsonOrText, JsonTree } from "./json-tree.tsx";
import { describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen } = await import("@testing-library/react");
const { afterEach } = await import("bun:test");

afterEach(() => cleanup());

describe("JsonTree", () => {
	it("renders object keys and values", () => {
		render(<JsonTree data={{ year: 2026 }} />);
		expect(screen.getByText(/year/)).toBeTruthy();
		expect(screen.getByText("2026")).toBeTruthy();
	});
});

describe("JsonOrText", () => {
	it("renders a JSON object string as a tree", () => {
		render(<JsonOrText raw='{"year":2026}' />);
		expect(screen.getByText(/year/)).toBeTruthy();
		expect(screen.getByText("2026")).toBeTruthy();
	});

	it("renders a non-JSON string as plain text", () => {
		render(<JsonOrText raw="just a string" />);
		expect(screen.getByText("just a string")).toBeTruthy();
	});

	it("renders a bare scalar string as plain text, not a tree", () => {
		render(<JsonOrText raw="42" />);
		expect(screen.getByText("42")).toBeTruthy();
	});
});
