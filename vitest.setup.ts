import { afterAll, afterEach, beforeAll } from "vitest";

import { server } from "./src/test-server.ts";

beforeAll(() => {
	server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
	server.resetHandlers();
});

afterAll(() => {
	server.close();
});
