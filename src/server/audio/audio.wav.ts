import { InvalidWavFormatError } from "./audio.errors.ts";
import type { StereoWav } from "./audio.types.ts";

const RIFF = 0x52494646; // "RIFF"
const WAVE = 0x57415645; // "WAVE"
const FMT = 0x666d7420; // "fmt "
const DATA = 0x64617461; // "data"
const PCM_FORMAT = 1;
const REQUIRED_SAMPLE_RATE = 48_000;
const REQUIRED_CHANNELS = 2;
const REQUIRED_BITS = 16;

/**
 * Parse a 48kHz int16 stereo WAV (RIFF/PCM) from a byte array. Walks chunks,
 * skips unknown ones (LIST/JUNK/INFO from ffmpeg/iOS), respects the RIFF
 * odd-size pad-byte rule. Throws `InvalidWavFormatError` on any deviation
 * from the required format.
 */
export function readStereoWav(buf: Uint8Array): StereoWav {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	if (buf.byteLength < 44) throw new InvalidWavFormatError("file too short");
	if (view.getUint32(0, false) !== RIFF) throw new InvalidWavFormatError("missing RIFF tag");
	if (view.getUint32(8, false) !== WAVE) throw new InvalidWavFormatError("missing WAVE tag");

	let cursor = 12;
	let sampleRate = 0;
	let channelCount = 0;
	let bitsPerSample = 0;
	let dataStart = -1;
	let dataLen = 0;
	let fmtSeen = false;

	// Walk every chunk to the end of the buffer — DO NOT break out early on
	// `data`, because some WAVs put `data` before `fmt ` (RIFF permits either
	// order). Breaking early would leave `sampleRate`/`channelCount`/
	// `bitsPerSample` at zero and the validation block below would throw
	// "sample rate 0" instead of the honest "missing fmt chunk".
	while (cursor + 8 <= buf.byteLength) {
		const chunkId = view.getUint32(cursor, false);
		const chunkSize = view.getUint32(cursor + 4, true);
		cursor += 8;
		if (chunkId === FMT) {
			if (chunkSize < 16) throw new InvalidWavFormatError(`fmt chunk too short (${chunkSize})`);
			const audioFormat = view.getUint16(cursor, true);
			if (audioFormat !== PCM_FORMAT) {
				throw new InvalidWavFormatError(`audio format ${audioFormat}, expected PCM(1)`);
			}
			channelCount = view.getUint16(cursor + 2, true);
			sampleRate = view.getUint32(cursor + 4, true);
			bitsPerSample = view.getUint16(cursor + 14, true);
			fmtSeen = true;
		} else if (chunkId === DATA && dataStart < 0) {
			dataStart = cursor;
			dataLen = chunkSize;
		}
		cursor += chunkSize + (chunkSize & 1);
	}

	if (!fmtSeen) throw new InvalidWavFormatError("missing fmt chunk");
	if (sampleRate !== REQUIRED_SAMPLE_RATE) {
		throw new InvalidWavFormatError(`sample rate ${sampleRate}, expected ${REQUIRED_SAMPLE_RATE}`);
	}
	if (channelCount !== REQUIRED_CHANNELS) {
		throw new InvalidWavFormatError(`channel count ${channelCount}, expected ${REQUIRED_CHANNELS}`);
	}
	if (bitsPerSample !== REQUIRED_BITS) {
		throw new InvalidWavFormatError(`bits per sample ${bitsPerSample}, expected ${REQUIRED_BITS}`);
	}
	if (dataStart < 0) throw new InvalidWavFormatError("missing data chunk");

	// `dataLen` is attacker-controlled (read straight from the WAV header).
	// Without this check, a 44-byte file declaring dataLen=0xFFFFFFFF would
	// trigger a ~4GB allocation in the two Int16Array constructors below —
	// crashing the Bun worker process. The body cap on /audio gates upload
	// size, but not the declared chunk size inside the file.
	if (dataStart + dataLen > buf.byteLength) {
		throw new InvalidWavFormatError(
			`data chunk overruns buffer (declared ${dataLen} bytes, ${buf.byteLength - dataStart} available)`,
		);
	}

	const samplesPerChannel = Math.floor(dataLen / 4);
	const left = new Int16Array(samplesPerChannel);
	const right = new Int16Array(samplesPerChannel);
	for (let i = 0; i < samplesPerChannel; i++) {
		left[i] = view.getInt16(dataStart + i * 4, true);
		right[i] = view.getInt16(dataStart + i * 4 + 2, true);
	}
	return { sampleRate, bitsPerSample: 16, left, right };
}

/**
 * Write a 48kHz int16 stereo WAV. The header is the fixed 44-byte PCM/RIFF
 * shape — ffmpeg and ffprobe read this without warnings (verified by spike).
 */
export function writeStereoWav(wav: StereoWav): Uint8Array {
	if (wav.left.length !== wav.right.length) {
		throw new InvalidWavFormatError("left and right must have identical length");
	}
	const samples = wav.left.length;
	const dataBytes = samples * 4;
	const fileBytes = 44 + dataBytes;
	const out = new Uint8Array(fileBytes);
	const view = new DataView(out.buffer);
	view.setUint32(0, RIFF, false);
	view.setUint32(4, 36 + dataBytes, true);
	view.setUint32(8, WAVE, false);
	view.setUint32(12, FMT, false);
	view.setUint32(16, 16, true);
	view.setUint16(20, PCM_FORMAT, true);
	view.setUint16(22, REQUIRED_CHANNELS, true);
	view.setUint32(24, wav.sampleRate, true);
	view.setUint32(28, wav.sampleRate * REQUIRED_CHANNELS * (REQUIRED_BITS / 8), true);
	view.setUint16(32, REQUIRED_CHANNELS * (REQUIRED_BITS / 8), true);
	view.setUint16(34, REQUIRED_BITS, true);
	view.setUint32(36, DATA, false);
	view.setUint32(40, dataBytes, true);
	for (let i = 0; i < samples; i++) {
		view.setInt16(44 + i * 4, wav.left[i] ?? 0, true);
		view.setInt16(44 + i * 4 + 2, wav.right[i] ?? 0, true);
	}
	return out;
}

/**
 * Linear-interpolation downsample from `srcRate` to `dstRate`. Used to bring
 * 48kHz int16 mono into the 16kHz expected by VAD. Linear is fine for VAD
 * (we don't need spectral fidelity — only energy + ZCR).
 */
export function downsamplePcm(pcm: Int16Array, srcRate: number, dstRate: number): Int16Array {
	if (srcRate === dstRate) return pcm;
	const ratio = srcRate / dstRate;
	const outLen = Math.floor(pcm.length / ratio);
	const out = new Int16Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const srcF = i * ratio;
		const i0 = Math.floor(srcF);
		const i1 = Math.min(i0 + 1, pcm.length - 1);
		const t = srcF - i0;
		const s0 = pcm[i0] ?? 0;
		const s1 = pcm[i1] ?? 0;
		out[i] = Math.round(s0 * (1 - t) + s1 * t);
	}
	return out;
}
