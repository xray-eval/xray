import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen } = await import("@testing-library/react");
const { RunStatusBadge } = await import("./replay-status.tsx");

afterEach(() => cleanup());

describe("RunStatusBadge", () => {
	it("renders pending as a neutral secondary badge", () => {
		render(<RunStatusBadge replay={{ lifecycle_state: "pending", failure_reason: null }} />);
		const badge = screen.getByText("pending");
		expect(badge.textContent).toBe("pending");
		expect(badge.getAttribute("data-variant")).toBe("secondary");
		expect(badge.className).not.toMatch(/bg-warning|bg-success|bg-destructive/);
	});

	it("renders recording_uploaded with the warning style and a space-separated label", () => {
		render(
			<RunStatusBadge replay={{ lifecycle_state: "recording_uploaded", failure_reason: null }} />,
		);
		const badge = screen.getByText("recording uploaded");
		expect(badge.className).toMatch(/bg-warning/);
		expect(badge.className).toMatch(/text-warning-foreground/);
	});

	it("renders analyzing with the warning style", () => {
		render(<RunStatusBadge replay={{ lifecycle_state: "analyzing", failure_reason: null }} />);
		const badge = screen.getByText("analyzing");
		expect(badge.className).toMatch(/bg-warning/);
		expect(badge.className).toMatch(/text-warning-foreground/);
	});
});
