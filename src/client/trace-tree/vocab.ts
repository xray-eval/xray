import { match } from "ts-pattern";

import type { SpanVocabulary } from "@/client/api/api.types.ts";

export type VocabPalette = Readonly<{
	dotBg: string;
	text: string;
	barFill: string;
	barOutline: string;
}>;

/**
 * Two-character text indicator so the vocabulary stays distinguishable
 * without relying on dot color alone (WCAG 1.4.1). Full vocab name is
 * announced by aria-label + native `title` tooltip at the call site.
 */
export function vocabShortLabel(vocab: SpanVocabulary): string {
	return match(vocab)
		.with("xray", () => "xr")
		.with("gen_ai", () => "ga")
		.with("langfuse", () => "lf")
		.exhaustive();
}

/** Human-readable vocabulary name for headings (the raw value is `gen_ai`). */
export function vocabLabel(vocab: SpanVocabulary): string {
	return match(vocab)
		.with("xray", () => "xray")
		.with("gen_ai", () => "GenAI")
		.with("langfuse", () => "Langfuse")
		.exhaustive();
}

export function vocabPalette(vocab: SpanVocabulary): VocabPalette {
	return match<SpanVocabulary, VocabPalette>(vocab)
		.with("xray", () => ({
			dotBg: "bg-amber-400 shadow-[0_0_6px_rgb(251_191_36/0.55)]",
			text: "text-amber-100/95",
			barFill: "rgb(251 191 36 / 0.55)",
			barOutline: "rgb(251 191 36)",
		}))
		.with("gen_ai", () => ({
			dotBg: "bg-violet-400 shadow-[0_0_6px_rgb(167_139_250/0.55)]",
			text: "text-violet-100/95",
			barFill: "rgb(167 139 250 / 0.55)",
			barOutline: "rgb(167 139 250)",
		}))
		.with("langfuse", () => ({
			dotBg: "bg-emerald-400 shadow-[0_0_6px_rgb(52_211_153/0.55)]",
			text: "text-emerald-100/95",
			barFill: "rgb(52 211 153 / 0.55)",
			barOutline: "rgb(52 211 153)",
		}))
		.exhaustive();
}
