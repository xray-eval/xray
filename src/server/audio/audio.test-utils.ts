import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertConversation } from "@/server/conversations/conversations.service.ts";
import { makeConversationSpec } from "@/server/conversations/conversations.test-utils.ts";
import { createReplay } from "@/server/replays/replays.service.ts";
import { makeCreateReplayRequest } from "@/server/replays/replays.test-utils.ts";
import { replayTurns } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";

export interface AudioFixtureReplay {
	readonly replayId: string;
	readonly turnIdx: number;
}

export function seedReplayWithTurn(
	store: Store,
	overrides: {
		conversationId?: string;
		conversationVersion?: string;
		turnIdx?: number;
	} = {},
): AudioFixtureReplay {
	const conversationId = overrides.conversationId ?? "conv-audio";
	const conversationVersion = overrides.conversationVersion ?? "v1";
	const turnIdx = overrides.turnIdx ?? 0;
	upsertConversation(
		store,
		makeConversationSpec({ id: conversationId, version: conversationVersion }),
	);
	const detail = createReplay(
		store,
		makeCreateReplayRequest({ conversationId, conversationVersion }),
	);
	store.db
		.insert(replayTurns)
		.values({
			replayId: detail.id,
			idx: turnIdx,
			role: "agent",
			key: null,
			startedAt: "2026-05-18T12:00:00.000Z",
			endedAt: "2026-05-18T12:00:02.000Z",
			transcript: null,
			audioPath: null,
		})
		.run();
	return { replayId: detail.id, turnIdx };
}

export function makeTempAudioRoot(): { path: string; dispose(): void } {
	const path = mkdtempSync(join(tmpdir(), "xray-audio-test-"));
	return {
		path,
		dispose: () => {
			rmSync(path, { recursive: true, force: true });
		},
	};
}

export function audioUrl(replayId: string, turnIdx?: number): string {
	if (turnIdx === undefined) {
		return `http://test.local/v1/replays/${replayId}/audio`;
	}
	return `http://test.local/v1/replays/${replayId}/turns/${turnIdx}/audio`;
}

export function fakeAudioBytes(seed = 0): Uint8Array<ArrayBuffer> {
	const len = 64;
	const out = new Uint8Array(new ArrayBuffer(len));
	for (let i = 0; i < len; i++) out[i] = (seed + i * 7) & 0xff;
	return out;
}
