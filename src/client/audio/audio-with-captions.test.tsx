import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render } = await import("@testing-library/react");
const { AudioWithCaptions, toCaptionsDataUrl } = await import("./audio-with-captions.tsx");

afterEach(() => cleanup());

describe("toCaptionsDataUrl", () => {
	it("returns a data:text/vtt URL that decodes to a valid VTT cue containing the transcript", () => {
		const url = toCaptionsDataUrl("hello world");
		expect(url.startsWith("data:text/vtt;charset=utf-8,")).toBe(true);
		const decoded = decodeURIComponent(url.slice("data:text/vtt;charset=utf-8,".length));
		expect(decoded.startsWith("WEBVTT")).toBe(true);
		expect(decoded).toMatch(/00:00:00\.000 --> 00:30:00\.000/);
		expect(decoded).toContain("hello world");
	});

	it("falls back to a placeholder cue when the caption text is null or empty", () => {
		const url = toCaptionsDataUrl(null);
		const decoded = decodeURIComponent(url.slice("data:text/vtt;charset=utf-8,".length));
		expect(decoded).toContain("(no transcript)");
	});

	it("collapses newlines in the transcript to spaces so the VTT cue stays single-line", () => {
		const url = toCaptionsDataUrl("line one\nline two");
		const decoded = decodeURIComponent(url.slice("data:text/vtt;charset=utf-8,".length));
		expect(decoded).toContain("line one line two");
	});
});

describe("AudioWithCaptions", () => {
	it("emits a <track kind=\"captions\"> with a data:text/vtt URL built from the prop", () => {
		const { container } = render(
			<AudioWithCaptions src="/v1/replays/x/audio" captionText="hello" label="test" />,
		);
		const track = container.querySelector("track");
		expect(track).not.toBeNull();
		expect(track?.getAttribute("kind")).toBe("captions");
		const trackSrc = track?.getAttribute("src");
		expect(trackSrc?.startsWith("data:text/vtt;")).toBe(true);
		const decoded = decodeURIComponent(trackSrc?.split(",")[1] ?? "");
		expect(decoded).toContain("hello");
	});
});
