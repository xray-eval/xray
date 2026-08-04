import { RendererUrlError } from "./dev.errors.ts";

/**
 * The port the renderer must listen on, read off the `rendererUrl` Cosmos loads
 * it from, so the two can't drift into a workbench whose iframe points at
 * nothing.
 *
 * Split from `serve-renderer.ts` because that module imports `./index.html` —
 * a Bun bundler entry point, not something a unit test should pull in to check
 * a string. Here the rule is exercisable on its own.
 *
 * Throws `RendererUrlError` for anything without an explicit port. A relative
 * URL or a bare `http://localhost` can't produce one, and defaulting to 80 or
 * 5051 would silently serve somewhere Cosmos isn't looking.
 */
export function rendererPort(url: string): number {
	const parsed = URL.parse(url);
	if (parsed === null || parsed.port === "") throw new RendererUrlError(url);
	return Number(parsed.port);
}
