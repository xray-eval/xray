import type { CompareRunConfigsResponse, RunConfigGroupResult } from "@/client/api/api.types.ts";

import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { CoverageNotice } = await import("./coverage-notice.tsx");
const { makeRunConfigMetrics } = await import("./test-utils.ts");

afterEach(() => cleanup());

function group(conversations: number): RunConfigGroupResult {
	return {
		hash: "a".repeat(64),
		name: "baseline",
		config: { model: "gpt-4o" },
		coverage: { conversations, replays: conversations, failed_replays: 0 },
		metrics: makeRunConfigMetrics(),
	};
}

function comparison(over: Partial<CompareRunConfigsResponse> = {}): CompareRunConfigsResponse {
	return {
		replay_selection: "latest",
		conversation_scope: "union",
		union_conversations: 3,
		intersection_conversations: 2,
		groups: [group(3), group(2)],
		...over,
	};
}

describe("CoverageNotice", () => {
	it("says nothing when every config ran the same conversations", () => {
		render(
			<CoverageNotice
				comparison={comparison({ groups: [group(3), group(3)] })}
				scope="union"
				onChangeScope={() => undefined}
			/>,
		);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("warns on uneven coverage and offers the one-click narrowing", () => {
		const asked: string[] = [];
		render(
			<CoverageNotice
				comparison={comparison()}
				scope="union"
				onChangeScope={(next) => asked.push(next)}
			/>,
		);
		expect(screen.getByRole("status").textContent).toContain("Only 2 of 3");
		fireEvent.click(screen.getByRole("button", { name: "Compare shared only" }));
		expect(asked).toEqual(["intersection"]);
	});

	it("under intersection, states what the numbers were narrowed to", () => {
		render(
			<CoverageNotice
				comparison={comparison()}
				scope="intersection"
				onChangeScope={() => undefined}
			/>,
		);
		const status = screen.getByRole("status");
		expect(status.textContent).toContain("2 conversations");
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("calls an empty intersection a dead end rather than offering to narrow into it", () => {
		render(
			<CoverageNotice
				comparison={comparison({ intersection_conversations: 0 })}
				scope="union"
				onChangeScope={() => undefined}
			/>,
		);
		expect(screen.getByRole("status").textContent).toContain("no conversations in common");
		// Narrowing would empty the matrix entirely, so the fix on offer is the
		// opposite one — and under `union` there is nothing to offer at all.
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("offers the way back out when the user is standing in an empty intersection", () => {
		const asked: string[] = [];
		render(
			<CoverageNotice
				comparison={comparison({ intersection_conversations: 0 })}
				scope="intersection"
				onChangeScope={(next) => asked.push(next)}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Show all runs" }));
		expect(asked).toEqual(["union"]);
	});
});
