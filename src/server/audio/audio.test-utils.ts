import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertConversation } from "@/server/conversations/conversations.service.ts";
import { makeConversationSpec } from "@/server/conversations/conversations.test-utils.ts";
import { createReplay } from "@/server/replays/replays.service.ts";
import { makeCreateReplayRequest } from "@/server/replays/replays.test-utils.ts";
import type { Store } from "@/server/store/store.ts";

export interface AudioFixtureReplay {
	readonly replayId: string;
}

export function seedReplayForAudio(
	store: Store,
	overrides: {
		conversationId?: string;
		conversationVersion?: string;
	} = {},
): AudioFixtureReplay {
	const conversationId = overrides.conversationId ?? "conv-audio";
	const conversationVersion = overrides.conversationVersion ?? "v1";
	upsertConversation(
		store,
		makeConversationSpec({ id: conversationId, version: conversationVersion }),
	);
	const detail = createReplay(
		store,
		makeCreateReplayRequest({
			conversation_id: conversationId,
			conversation_version: conversationVersion,
		}),
	);
	return { replayId: detail.id };
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

export function replayAudioUrl(replayId: string): string {
	return `http://test.local/v1/replays/${replayId}/audio`;
}

export function fakeAudioBytes(seed = 0): Uint8Array<ArrayBuffer> {
	const len = 64;
	const out = new Uint8Array(new ArrayBuffer(len));
	for (let i = 0; i < len; i++) out[i] = (seed + i * 7) & 0xff;
	return out;
}
