import { sourceBadgeVariant } from "./source-badge.ts";
import { describe, expect, it } from "bun:test";

describe("sourceBadgeVariant", () => {
	it("maps ingest to the default variant", () => {
		expect(sourceBadgeVariant("ingest")).toBe("default");
	});

	it("maps adapter:* to the secondary variant", () => {
		expect(sourceBadgeVariant("adapter:elevenlabs")).toBe("secondary");
		expect(sourceBadgeVariant("adapter:vapi")).toBe("secondary");
		expect(sourceBadgeVariant("adapter:retell")).toBe("secondary");
	});
});
