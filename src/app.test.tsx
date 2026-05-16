import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { describe, expect, it } from "bun:test";

// happy-dom must be registered before @testing-library/react evaluates — it
// reads `document` at module load. Dynamic import preserves that ordering;
// static `import` would be hoisted above the register() call.
GlobalRegistrator.register();
const { render, screen } = await import("@testing-library/react");
const { App } = await import("./app.tsx");

describe("App", () => {
	it("renders the xray heading", () => {
		render(<App />);
		expect(screen.getByRole("heading", { name: /xray/i })).toBeTruthy();
	});
});
