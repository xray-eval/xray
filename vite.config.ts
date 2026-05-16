import react from "@vitejs/plugin-react";
import * as v from "valibot";
import { defineConfig } from "vite";

const ViteEnvSchema = v.object({
	VITE_API_PROXY: v.optional(v.pipe(v.string(), v.url()), "http://localhost:8080"),
});
const viteEnv = v.parse(ViteEnvSchema, process.env);

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@": new URL("./src", import.meta.url).pathname,
		},
	},
	server: {
		host: "0.0.0.0",
		port: 5173,
		// Hono proxy lives at /api — see src/server/server.ts. Vite forwards
		// XHR/fetch to the Bun process during dev so the SPA and the proxy
		// share a single origin from the browser's point of view.
		proxy: {
			"/api": {
				target: viteEnv.VITE_API_PROXY,
				changeOrigin: true,
			},
		},
	},
});
