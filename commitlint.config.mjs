// Conventional commits — enforced by lefthook's commit-msg hook.
// Format: <type>(<scope>)?: <subject>
// Types: feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert
export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		// Subject is required (config-conventional allows empty in some configs)
		"subject-empty": [2, "never"],
		// No trailing full stop on the subject line
		"subject-full-stop": [2, "never", "."],
		// Cap header length at 100 chars (default 72 is too tight for our scopes)
		"header-max-length": [2, "always", 100],
	},
};
