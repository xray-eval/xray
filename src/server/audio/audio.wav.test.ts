import { InvalidWavFormatError } from "./audio.errors.ts";
import type { StereoWav } from "./audio.types.ts";
import { downsamplePcm, readStereoWav, writeStereoWav } from "./audio.wav.ts";
import { describe, expect, it } from "bun:test";

function makeSineStereo(seconds: number): StereoWav {
	const sampleRate = 48_000;
	const samples = sampleRate * seconds;
	const left = new Int16Array(samples);
	const right = new Int16Array(samples);
	for (let i = 0; i < samples; i++) {
		left[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 10_000);
		right[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 10_000);
	}
	return { sampleRate, bitsPerSample: 16, left, right };
}

describe("writeStereoWav / readStereoWav", () => {
	it("round-trips a 1-second stereo PCM signal byte-for-byte", () => {
		const original = makeSineStereo(1);
		const bytes = writeStereoWav(original);
		const decoded = readStereoWav(bytes);
		expect(decoded.sampleRate).toBe(48_000);
		expect(decoded.bitsPerSample).toBe(16);
		expect(decoded.left.length).toBe(original.left.length);
		expect(decoded.right.length).toBe(original.right.length);
		for (let i = 0; i < 100; i++) {
			expect(decoded.left[i]).toBe(original.left[i] ?? 0);
			expect(decoded.right[i]).toBe(original.right[i] ?? 0);
		}
	});

	it("produces a 44-byte header followed by interleaved samples", () => {
		const wav = makeSineStereo(0.01);
		const bytes = writeStereoWav(wav);
		expect(bytes.byteLength).toBe(44 + wav.left.length * 4);
	});
});

describe("readStereoWav — rejections", () => {
	it("throws when the file is too short", () => {
		expect(() => readStereoWav(new Uint8Array(10))).toThrow(InvalidWavFormatError);
	});

	it("throws when the RIFF tag is missing", () => {
		const bytes = new Uint8Array(50);
		expect(() => readStereoWav(bytes)).toThrow(InvalidWavFormatError);
	});

	it("throws on mono WAV", () => {
		const sampleRate = 48_000;
		const samples = sampleRate;
		const buf = new Uint8Array(44 + samples * 2);
		const view = new DataView(buf.buffer);
		view.setUint32(0, 0x52494646, false);
		view.setUint32(4, 36 + samples * 2, true);
		view.setUint32(8, 0x57415645, false);
		view.setUint32(12, 0x666d7420, false);
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true); // mono
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * 2, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		view.setUint32(36, 0x64617461, false);
		view.setUint32(40, samples * 2, true);
		expect(() => readStereoWav(buf)).toThrow(InvalidWavFormatError);
	});

	it("throws on non-PCM audio format", () => {
		const buf = new Uint8Array(44);
		const view = new DataView(buf.buffer);
		view.setUint32(0, 0x52494646, false);
		view.setUint32(4, 36, true);
		view.setUint32(8, 0x57415645, false);
		view.setUint32(12, 0x666d7420, false);
		view.setUint32(16, 16, true);
		view.setUint16(20, 3, true); // float, not PCM
		expect(() => readStereoWav(buf)).toThrow(InvalidWavFormatError);
	});

	it("skips unknown chunks (LIST/INFO/JUNK) between RIFF header and data", () => {
		const sampleRate = 48_000;
		const samples = 4;
		const junkSize = 4;
		const buf = new Uint8Array(12 + 8 + junkSize + 8 + 16 + 8 + samples * 4);
		const view = new DataView(buf.buffer);
		let o = 0;
		view.setUint32(o, 0x52494646, false);
		o += 4;
		view.setUint32(o, buf.byteLength - 8, true);
		o += 4;
		view.setUint32(o, 0x57415645, false);
		o += 4;
		// JUNK chunk first
		view.setUint32(o, 0x4a554e4b, false);
		o += 4;
		view.setUint32(o, junkSize, true);
		o += 4;
		o += junkSize;
		// fmt chunk
		view.setUint32(o, 0x666d7420, false);
		o += 4;
		view.setUint32(o, 16, true);
		o += 4;
		view.setUint16(o, 1, true);
		view.setUint16(o + 2, 2, true);
		view.setUint32(o + 4, sampleRate, true);
		view.setUint32(o + 8, sampleRate * 4, true);
		view.setUint16(o + 12, 4, true);
		view.setUint16(o + 14, 16, true);
		o += 16;
		// data chunk
		view.setUint32(o, 0x64617461, false);
		o += 4;
		view.setUint32(o, samples * 4, true);
		o += 4;
		const decoded = readStereoWav(buf);
		expect(decoded.left.length).toBe(samples);
	});
});

describe("readStereoWav — hardening", () => {
	it("rejects a header that declares a `dataLen` exceeding the buffer (huge-alloc DoS guard)", () => {
		// Minimal valid header + fmt chunk; data chunk lies about its size.
		const buf = new Uint8Array(44);
		const view = new DataView(buf.buffer);
		view.setUint32(0, 0x52494646, false); // RIFF
		view.setUint32(4, 36, true);
		view.setUint32(8, 0x57415645, false); // WAVE
		view.setUint32(12, 0x666d7420, false); // "fmt "
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true); // PCM
		view.setUint16(22, 2, true); // stereo
		view.setUint32(24, 48_000, true);
		view.setUint32(28, 48_000 * 4, true);
		view.setUint16(32, 4, true);
		view.setUint16(34, 16, true);
		view.setUint32(36, 0x64617461, false); // "data"
		// Adversarial: declared dataLen is 0xFFFFFFFF but only 0 bytes follow.
		// Without the overrun check this allocates ~2GB twice.
		view.setUint32(40, 0xffffffff, true);
		expect(() => readStereoWav(buf)).toThrow(InvalidWavFormatError);
	});

	it("accepts data-before-fmt chunk ordering (RIFF spec permits either order)", () => {
		// Some encoders emit `data` before `fmt ` — legal RIFF. The parser used
		// to break out of the loop on DATA before reading FMT, then mis-report
		// "sample rate 0". Walking every chunk fixes the bug AND accepts the
		// file.
		const samples = 4;
		const buf = new Uint8Array(12 + 8 + samples * 4 + 8 + 16);
		const view = new DataView(buf.buffer);
		let o = 0;
		view.setUint32(o, 0x52494646, false);
		o += 4;
		view.setUint32(o, buf.byteLength - 8, true);
		o += 4;
		view.setUint32(o, 0x57415645, false);
		o += 4;
		// data chunk FIRST
		view.setUint32(o, 0x64617461, false);
		o += 4;
		view.setUint32(o, samples * 4, true);
		o += 4;
		o += samples * 4;
		// fmt chunk AFTER
		view.setUint32(o, 0x666d7420, false);
		o += 4;
		view.setUint32(o, 16, true);
		o += 4;
		view.setUint16(o, 1, true);
		view.setUint16(o + 2, 2, true);
		view.setUint32(o + 4, 48_000, true);
		view.setUint32(o + 8, 48_000 * 4, true);
		view.setUint16(o + 12, 4, true);
		view.setUint16(o + 14, 16, true);

		const decoded = readStereoWav(buf);
		expect(decoded.sampleRate).toBe(48_000);
		expect(decoded.left.length).toBe(samples);
		expect(decoded.right.length).toBe(samples);
	});

	it("throws `missing fmt chunk` (not `sample rate 0`) when fmt is entirely absent", () => {
		// Headers + a single data chunk; no fmt. Pre-fix, parser broke on DATA
		// and fired "sample rate 0" because fmt fields stayed at their zero
		// init. Post-fix, validation orders fmt-presence BEFORE field checks.
		// Pad to ≥44 bytes so the parser doesn't short-circuit on the
		// "file too short" guard before reaching the chunk loop.
		const samples = 8; // 32 data bytes
		const buf = new Uint8Array(12 + 8 + samples * 4); // 52 bytes
		const view = new DataView(buf.buffer);
		view.setUint32(0, 0x52494646, false);
		view.setUint32(4, buf.byteLength - 8, true);
		view.setUint32(8, 0x57415645, false);
		view.setUint32(12, 0x64617461, false);
		view.setUint32(16, samples * 4, true);
		try {
			readStereoWav(buf);
			throw new Error("expected throw");
		} catch (e) {
			expect(e).toBeInstanceOf(InvalidWavFormatError);
			if (!(e instanceof InvalidWavFormatError)) throw e;
			expect(e.message.toLowerCase()).toContain("fmt");
			expect(e.message.toLowerCase()).not.toContain("sample rate 0");
		}
	});
});

describe("downsamplePcm", () => {
	it("returns the input when src and dst rates match", () => {
		const pcm = new Int16Array([1, 2, 3, 4, 5]);
		const out = downsamplePcm(pcm, 48_000, 48_000);
		expect(out).toBe(pcm);
	});

	it("downsamples 48k→16k to one-third the length", () => {
		const samples = 4800;
		const pcm = new Int16Array(samples);
		for (let i = 0; i < samples; i++) {
			pcm[i] = i & 0x7fff;
		}
		const out = downsamplePcm(pcm, 48_000, 16_000);
		expect(out.length).toBe(1600);
	});
});
