import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
		// `src/server/store/**` imports `bun:sqlite` — runs under `bun test`
		// instead (see package.json `test:store`). v8 coverage doesn't work
		// under Bun's JSC runtime, so the store slice has its own runner.
		exclude: ["node_modules/**", "dist/**", "**/test-utils.ts", "src/server/store/**"],
		// Default to Node — most tests are server-side or pure logic. Tests
		// that need a DOM opt in via `// @vitest-environment happy-dom` at the
		// top of the file (see `src/app.test.tsx`).
		environment: "node",
		globals: false,
		clearMocks: true,
		restoreMocks: true,
		setupFiles: ["./vitest.setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			include: ["src/**/*.ts", "src/**/*.tsx"],
			exclude: [
				"**/*.test.ts",
				"**/*.test.tsx",
				"**/test-utils.ts",
				"**/types.ts",
				"src/main.tsx",
				"src/test-server.ts",
				// Store slice runs under `bun test` (see exclude above).
				"src/server/store/**",
			],
			// Floor — see .claude/rules/tdd.md "Coverage gates". Don't lower
			// without a written reason in the commit message.
			thresholds: {
				lines: 80,
				branches: 80,
				functions: 80,
				statements: 80,
			},
		},
	},
	resolve: {
		alias: {
			"@": new URL("./src", import.meta.url).pathname,
		},
	},
});
