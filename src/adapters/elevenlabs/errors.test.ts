import { describe, expect, it } from "vitest";

import { AdapterError } from "../errors/errors.ts";
import { ElevenLabsMissingWorkflowError } from "./errors.ts";

describe("ElevenLabsMissingWorkflowError", () => {
	it("is catchable as AdapterError", () => {
		const err = new ElevenLabsMissingWorkflowError("agent_1");
		expect(err).toBeInstanceOf(AdapterError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("ElevenLabsMissingWorkflowError");
	});

	it("exposes the agent id as a typed field", () => {
		const err = new ElevenLabsMissingWorkflowError("agent_1");
		expect(err.agentId).toBe("agent_1");
	});
});
