import {
	InvalidRunConfigHashError,
	InvalidRunConfigRequestError,
	MalformedRunConfigBodyError,
	RunConfigBodyTooLargeError,
	RunConfigError,
	RunConfigNotFoundError,
} from "./run-configs.errors.ts";
import { describe, expect, test } from "bun:test";

describe("run config errors", () => {
	test("RunConfigNotFoundError is catchable as RunConfigError and keeps its hash", () => {
		const err = new RunConfigNotFoundError("a".repeat(64));
		expect(err).toBeInstanceOf(RunConfigError);
		expect(err.name).toBe("RunConfigNotFoundError");
		expect(err.configHash).toBe("a".repeat(64));
	});

	test("InvalidRunConfigHashError carries its issues", () => {
		const err = new InvalidRunConfigHashError([]);
		expect(err).toBeInstanceOf(RunConfigError);
		expect(err.name).toBe("InvalidRunConfigHashError");
		expect(err.issues).toEqual([]);
	});

	test("InvalidRunConfigRequestError carries its issues", () => {
		const err = new InvalidRunConfigRequestError([]);
		expect(err).toBeInstanceOf(RunConfigError);
		expect(err.name).toBe("InvalidRunConfigRequestError");
		expect(err.issues).toEqual([]);
	});

	test("MalformedRunConfigBodyError preserves the parse failure as its cause", () => {
		const cause = new SyntaxError("unexpected token");
		const err = new MalformedRunConfigBodyError({ cause });
		expect(err).toBeInstanceOf(RunConfigError);
		expect(err.name).toBe("MalformedRunConfigBodyError");
		expect(err.cause).toBe(cause);
		expect(err.issues).toEqual([]);
	});

	test("RunConfigBodyTooLargeError reports the cap it enforced", () => {
		const err = new RunConfigBodyTooLargeError(16_384);
		expect(err).toBeInstanceOf(RunConfigError);
		expect(err.name).toBe("RunConfigBodyTooLargeError");
		expect(err.maxBytes).toBe(16_384);
	});
});
