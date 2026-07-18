/**
 * Base64-encode raw bytes for inline JSON payloads (Gemini `inline_data`,
 * Bedrock Converse `audio.source.bytes`). Chunked `btoa` because
 * `String.fromCharCode(...bytes)` overflows the argument limit on large
 * WAVs. Lives in `core/` because multiple provider slices inline audio —
 * an encoding bug should be fixed once, not per provider.
 */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}
