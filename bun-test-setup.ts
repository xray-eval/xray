import { server } from "./src/test-server.ts";
import { afterAll, afterEach, beforeAll } from "bun:test";

beforeAll(() => server.enable());

afterEach(() => {
	server.resetHandlers();
});

afterAll(() => server.disable());
