import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// One config for both sides. Per-project splits (client/server) can come
		// later via `test.projects` if their needs diverge enough — until then,
		// keep it simple.
		include: ["src/**/*.test.ts", "src/**/*.test.tsx", "server/**/*.test.ts"],
		exclude: ["node_modules/**", "dist/**", "**/test-utils.ts"],
		environment: "happy-dom",
		// Vitest's globals are *not* enabled — every test file imports describe/
		// it/expect from "vitest" explicitly. Discoverable, no magic.
		globals: false,
		clearMocks: true,
		restoreMocks: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			include: ["src/**/*.ts", "src/**/*.tsx", "server/**/*.ts"],
			exclude: [
				"**/*.test.ts",
				"**/*.test.tsx",
				"**/test-utils.ts",
				"**/types.ts",
				"server/index.ts",
			],
			// Floor — see .claude/rules/tdd.md "Coverage gates". Bump as the
			// codebase fills in; don't lower without a written reason in the
			// commit message.
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
