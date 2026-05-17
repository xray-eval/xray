// Production build entry. `bun build` CLI does not yet support plugins for
// HTML entrypoints (Bun docs: "plugins are only supported through Bun.build's
// API or through bunfig.toml with the frontend dev server — not yet supported
// in bun build's CLI"). bunfig.toml's `[serve.static].plugins` covers dev via
// Bun.serve but not the prod build, so this script invokes Bun.build
// programmatically with the Tailwind plugin loaded.
import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
	entrypoints: ["./index.html"],
	outdir: "./dist",
	target: "browser",
	minify: true,
	sourcemap: "none",
	// React's dev-only warnings + Object.freeze on every props object are
	// gated on `process.env.NODE_ENV !== "production"`. Without this define
	// the bundle includes ~200 KB of dev-only paths.
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
	plugins: [tailwind],
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
