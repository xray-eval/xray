import { IncompatibleInterceptorError, TestServerError } from "@/test-server.errors.ts";

import { expect, test } from "bun:test";

test("IncompatibleInterceptorError is a TestServerError carrying the interceptor name", () => {
	const error = new IncompatibleInterceptorError("FetchInterceptor");
	expect(error).toBeInstanceOf(TestServerError);
	expect(error).toBeInstanceOf(Error);
	expect(error.name).toBe("IncompatibleInterceptorError");
	expect(error.interceptorName).toBe("FetchInterceptor");
});

test("TestServerError sets its own name", () => {
	expect(new TestServerError("x").name).toBe("TestServerError");
});
