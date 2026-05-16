import { setupServer } from "msw/node";

/**
 * Shared MSW server. Empty at startup — every test registers its own handlers
 * via `server.use(...)`. Lifecycle hooks (listen/reset/close) live in
 * `bun-test-setup.ts` at the project root (preloaded via bunfig.toml); tests
 * only import this singleton.
 *
 * `onUnhandledRequest: "error"` (configured in bun-test-setup.ts) means any
 * real network call from production code under test will fail loudly — there
 * is no implicit pass-through.
 */
export const server = setupServer();
