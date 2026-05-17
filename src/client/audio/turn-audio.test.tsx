import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render } = await import("@testing-library/react");
const { TurnAudio } = await import("./turn-audio.tsx");

afterEach(() => cleanup());

function findAudio(container: HTMLElement): HTMLAudioElement {
	const audio = container.querySelector("audio");
	if (audio === null) throw new Error("expected <audio> in render output");
	return audio;
}

function findTrack(audio: HTMLAudioElement): HTMLTrackElement {
	const track = audio.querySelector("track");
	if (track === null) throw new Error("expected <track> inside <audio>");
	return track;
}

function decodeVtt(src: string): string {
	const prefix = "data:text/vtt;charset=utf-8,";
	if (!src.startsWith(prefix)) throw new Error(`expected VTT data URL, got ${src}`);
	return decodeURIComponent(src.slice(prefix.length));
}

describe("TurnAudio", () => {
	it("points the audio src at the session+turn HTTP endpoint", () => {
		const { container } = render(
			<TurnAudio sessionId="sess-1" turn={{ idx: 3, role: "agent", text: "hello there" }} />,
		);
		const audio = findAudio(container);
		expect(audio.getAttribute("src")).toContain("/v1/sessions/sess-1/turns/3/audio");
		expect(audio.getAttribute("preload")).toBe("none");
		expect(audio.getAttribute("aria-label")).toBe("Audio for agent turn 3");
	});

	it("emits a single-cue VTT track carrying the transcript", () => {
		const { container } = render(
			<TurnAudio sessionId="s" turn={{ idx: 0, role: "user", text: "book a table" }} />,
		);
		const track = findTrack(findAudio(container));
		expect(track.getAttribute("kind")).toBe("captions");
		expect(track.getAttribute("srclang")).toBe("en");
		const vtt = decodeVtt(track.getAttribute("src") ?? "");
		expect(vtt).toContain("WEBVTT");
		expect(vtt).toContain("book a table");
	});

	it('replaces the VTT cue terminator "-->" in transcripts so the cue stays parseable', () => {
		const { container } = render(
			<TurnAudio
				sessionId="s"
				turn={{
					idx: 0,
					role: "agent",
					text: "left --> right --> done",
				}}
			/>,
		);
		const vtt = decodeVtt(findTrack(findAudio(container)).getAttribute("src") ?? "");
		// The literal "-->" must not appear anywhere in the cue body — VTT would
		// otherwise parse a second timestamp and the track would fail to load.
		expect(vtt.includes("left --> right")).toBe(false);
		expect(vtt).toContain("left → right → done");
		// Header timestamp is still well-formed.
		expect(vtt).toContain("00:00:00.000 --> 99:59:59.999");
	});

	it('falls back to "(no transcript)" when the turn text is empty or whitespace', () => {
		const { container } = render(
			<TurnAudio sessionId="s" turn={{ idx: 0, role: "agent", text: "   " }} />,
		);
		const vtt = decodeVtt(findTrack(findAudio(container)).getAttribute("src") ?? "");
		expect(vtt).toContain("(no transcript)");
	});
});
