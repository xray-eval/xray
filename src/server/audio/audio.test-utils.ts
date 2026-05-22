import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seedConversation } from "@/server/conversations/conversations.test-utils.ts";
import { createReplay } from "@/server/replays/replays.service.ts";
import type { Store } from "@/server/store/store.ts";

export interface AudioFixtureReplay {
	readonly replayId: string;
}

export async function seedReplayForAudio(
	store: Store,
	overrides: { conversationHash?: string } = {},
): Promise<AudioFixtureReplay> {
	const hash =
		overrides.conversationHash ?? (await seedConversation(store, { name: "conv-audio" })).hash;
	const detail = createReplay(store, { conversation_hash: hash });
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
