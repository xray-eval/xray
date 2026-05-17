import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveSession } from "@/server/store/sessions-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { makeSession, makeTurnInput } from "@/server/store/test-utils.ts";
import { appendTurns } from "@/server/store/turns-repo.ts";

export interface AudioFixtureSession {
	readonly sessionId: string;
	readonly turnIdx: number;
}

/**
 * Seed one session + one turn into the store so audio routes have something
 * to attach to. Returns the ids tests use to address the upload/download
 * endpoints.
 */
export function seedSessionWithTurn(
	store: Store,
	overrides: { sessionId?: string; turnIdx?: number; turnId?: string } = {},
): AudioFixtureSession {
	const sessionId = overrides.sessionId ?? "sess-A";
	const turnIdx = overrides.turnIdx ?? 0;
	const turnId = overrides.turnId ?? `turn-${sessionId}-${turnIdx}`;
	saveSession(store.db, makeSession({ id: sessionId }));
	appendTurns(store.db, sessionId, [makeTurnInput({ id: turnId, idx: turnIdx })]);
	return { sessionId, turnIdx };
}

/**
 * Disposable on-disk audio root. Each call returns a unique directory under
 * the OS tmp; the returned `dispose` removes the tree. Tests use it instead
 * of writing into `/data` so a failed test never leaves bytes behind.
 */
export function makeTempAudioRoot(): { path: string; dispose(): void } {
	const path = mkdtempSync(join(tmpdir(), "xray-audio-test-"));
	return {
		path,
		dispose: () => {
			rmSync(path, { recursive: true, force: true });
		},
	};
}

/** Build a request URL for the audio endpoints — single source of truth for the path shape. */
export function audioUrl(sessionId: string, turnIdx: number): string {
	return `http://test.local/v1/sessions/${sessionId}/turns/${turnIdx}/audio`;
}

/** Deterministic byte payload — content doesn't matter, only roundtrip
 *  equality. Returns `Uint8Array<ArrayBuffer>` so callers can pass it
 *  straight into `BodyInit` under TS 6's tightened generics. */
export function fakeAudioBytes(seed = 0): Uint8Array<ArrayBuffer> {
	const len = 64;
	const out = new Uint8Array(new ArrayBuffer(len));
	for (let i = 0; i < len; i++) out[i] = (seed + i * 7) & 0xff;
	return out;
}
