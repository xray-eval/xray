/**
 * Shared TTS + upload helper for the contributor scripts that drive xray's
 * audio endpoint (`seed.ts`, `agent-webhook.ts`). Not part of xray itself.
 */

export interface SynthesizeAndUploadParams {
	readonly apiKey: string;
	readonly xrayBase: string;
	readonly sessionId: string;
	readonly turnIdx: number;
	readonly text: string;
	readonly ttsModel: string;
	readonly voice: string;
}

export interface SynthesizeAndUploadResult {
	readonly ok: boolean;
	readonly bytes?: number;
	readonly reason?: string;
}

export async function synthesizeAndUpload(
	params: SynthesizeAndUploadParams,
): Promise<SynthesizeAndUploadResult> {
	const { apiKey, xrayBase, sessionId, turnIdx, text, ttsModel, voice } = params;
	if (text.trim().length === 0) return { ok: false, reason: "empty text" };

	// WAV (PCM16 24 kHz mono) is the only TTS format OpenAI Realtime can ingest
	// directly. Browsers play WAV fine, so the text-only inspector view still
	// works — the only cost is larger files vs opus, which is a non-issue for
	// short demo turns. Switching here unblocks v2v replay end-to-end.
	const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ model: ttsModel, voice, input: text, response_format: "wav" }),
	});
	if (!ttsRes.ok) {
		return { ok: false, reason: `OpenAI TTS ${ttsRes.status}` };
	}
	const audioBytes = new Uint8Array(await ttsRes.arrayBuffer());

	const uploadUrl = `${xrayBase}/v1/sessions/${encodeURIComponent(sessionId)}/turns/${turnIdx}/audio`;
	const uploadRes = await fetch(uploadUrl, {
		method: "POST",
		headers: { "content-type": "audio/wav" },
		body: audioBytes,
	});
	if (!uploadRes.ok) {
		return { ok: false, reason: `xray audio upload ${uploadRes.status}` };
	}
	return { ok: true, bytes: audioBytes.byteLength };
}

export function isTruthy(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const s = raw.toLowerCase();
	return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function stripTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}
