import type { Env } from "./env.ts";

export function makeEnv(overrides: Partial<Env> = {}): Env {
	return {
		PORT: 8080,
		HOST: "127.0.0.1",
		XRAY_DATA_DIR: "/tmp/xray-test",
		...overrides,
	};
}
