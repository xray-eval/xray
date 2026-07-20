/**
 * Base64-encode raw bytes for inline JSON payloads (Gemini `inline_data`,
 * Bedrock Converse `audio.source.bytes`). Server-only (Bun), so `Buffer`
 * handles multi-MB WAVs directly — no `btoa`/`String.fromCharCode` chunking
 * dance and no argument-limit overflow. Lives in `core/` because multiple
 * provider slices inline audio — an encoding bug should be fixed once, not
 * per provider.
 */
export function bytesToBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}
