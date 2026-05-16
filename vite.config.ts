import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
				target: process.env["VITE_API_PROXY"] ?? "http://localhost:8080",
				changeOrigin: true,
			},
		},
	},
});
