// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./app.tsx";

describe("App", () => {
	it("renders the xray heading", () => {
		render(<App />);
		expect(screen.getByRole("heading", { name: /xray/i })).toBeTruthy();
	});
});
