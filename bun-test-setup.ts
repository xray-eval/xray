import { server } from "./src/test-server.ts";
import { afterAll, afterEach, beforeAll } from "bun:test";

beforeAll(() => {
	server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
	server.resetHandlers();
});

afterAll(() => {
	server.close();
});
