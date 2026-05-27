/**
 * Minimal subset of `fetch` the provider clients depend on. Bun's
 * `typeof fetch` includes a `preconnect` static method we don't use, and
 * matching it would force every test stub to ship a stub `preconnect` for
 * no reason. Accepting `FetchLike` keeps the seam thin and the tests
 * honest. Lives in `core/` because both the transcription and judge slices
 * inject it — it is not owned by either.
 */
export type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
