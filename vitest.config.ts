import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
		exclude: ["node_modules/**", "dist/**", "**/test-utils.ts"],
		environment: "happy-dom",
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
