// Production build entry. Plain `bun build ./index.html` does not load
// `bun-plugin-tailwind` (bunfig.toml's `[serve.static].plugins` only applies
// to `Bun.serve` HTML routes, not the build CLI), so `@import "tailwindcss"`,
// `@theme`, `@utility`, and `@custom-variant` emit "invalid @ rule" warnings
// and the bundled CSS is broken. This script loads the plugin explicitly and
// passes the production-mode flags (`bun build --production` shorthand for
// minify + NODE_ENV=production define).
import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
	entrypoints: ["./index.html"],
	outdir: "./dist",
	minify: true,
	sourcemap: "none",
	// React's dev-only warnings + Object.freeze on every props object are
	// gated on `process.env.NODE_ENV !== "production"`. Without this define
	// the bundle includes ~200 KB of dev-only paths.
	define: { "process.env.NODE_ENV": '"production"' },
	plugins: [tailwind],
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
