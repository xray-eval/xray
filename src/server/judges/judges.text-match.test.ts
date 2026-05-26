import { buildUserPrompt, runTextMatchJudge } from "./judges.text-match.ts";
import type { JudgeProvider } from "./judges.types.ts";
import { describe, expect, it } from "bun:test";

function fakeProvider(score: number, reason = "ok"): JudgeProvider {
	return {
		name: "fake",
		model: "fake-1",
		judge: async () => ({ score, reason }),
	};
}

describe("buildUserPrompt", () => {
	it("orders turns by turn_idx and labels each with role", () => {
		const prompt = buildUserPrompt({ reference: "agent confirms", rubric: null, passScore: 70 }, [
			{ turnIdx: 1, role: "agent", text: "Confirmed for two." },
			{ turnIdx: 0, role: "user", text: "Book a table for two." },
		]);
		expect(prompt).toContain("Reference behavior:\nagent confirms");
		expect(prompt).toContain("[turn 0] [user]: Book a table for two.");
		expect(prompt).toContain("[turn 1] [agent]: Confirmed for two.");
		// Turn 0 appears before turn 1 in the transcript block.
		expect(prompt.indexOf("[turn 0]")).toBeLessThan(prompt.indexOf("[turn 1]"));
	});

	it("includes the rubric block when provided", () => {
		const prompt = buildUserPrompt(
			{ reference: "ref", rubric: "Penalize hedging.", passScore: 70 },
			[{ turnIdx: 0, role: "agent", text: "yes." }],
		);
		expect(prompt).toContain("Additional rubric:\nPenalize hedging.");
	});

	it("omits the rubric block when null or empty", () => {
		const prompt = buildUserPrompt({ reference: "ref", rubric: null, passScore: 70 }, [
			{ turnIdx: 0, role: "agent", text: "yes." },
		]);
		expect(prompt).not.toContain("Additional rubric");
	});

	it("renders empty transcript explicitly so the LLM doesn't hallucinate", () => {
		const prompt = buildUserPrompt({ reference: "ref", rubric: null, passScore: 70 }, []);
		expect(prompt).toContain("Transcript:\n(empty)");
	});
});

describe("runTextMatchJudge", () => {
	it("maps score >= passScore to status: passed", async () => {
		const outcome = await runTextMatchJudge(
			{ reference: "x", rubric: null, passScore: 70 },
			[{ turnIdx: 0, role: "agent", text: "x" }],
			fakeProvider(85, "matches the reference"),
		);
		expect(outcome.status).toBe("passed");
		expect(outcome.score).toBe(85);
		expect(outcome.reason).toBe("matches the reference");
		expect(outcome.provider).toBe("fake");
		expect(outcome.model).toBe("fake-1");
	});

	it("maps score < passScore to status: failed", async () => {
		const outcome = await runTextMatchJudge(
			{ reference: "x", rubric: null, passScore: 70 },
			[{ turnIdx: 0, role: "agent", text: "x" }],
			fakeProvider(50),
		);
		expect(outcome.status).toBe("failed");
		expect(outcome.score).toBe(50);
	});

	it("treats score exactly equal to passScore as passed", async () => {
		const outcome = await runTextMatchJudge(
			{ reference: "x", rubric: null, passScore: 70 },
			[{ turnIdx: 0, role: "agent", text: "x" }],
			fakeProvider(70),
		);
		expect(outcome.status).toBe("passed");
	});

	it("propagates provider errors so the evaluate-replay processor can stamp errored", async () => {
		const failingProvider: JudgeProvider = {
			name: "fake",
			model: "fake-1",
			judge: async () => {
				throw new Error("provider down");
			},
		};
		await expect(
			runTextMatchJudge(
				{ reference: "x", rubric: null, passScore: 70 },
				[{ turnIdx: 0, role: "agent", text: "x" }],
				failingProvider,
			),
		).rejects.toThrow(/provider down/);
	});
});
