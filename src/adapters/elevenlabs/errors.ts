import { AdapterError } from "../errors/errors.ts";
import type { AgentId } from "../types.ts";

export class ElevenLabsMissingWorkflowError extends AdapterError {
	readonly agentId: AgentId;

	constructor(agentId: AgentId) {
		super(`Agent "${agentId}" has no workflow configured`);
		this.name = "ElevenLabsMissingWorkflowError";
		this.agentId = agentId;
	}
}
