import type { SpanResponse, SpanVocabulary, TurnRole } from "@/client/api/api.types.ts";

export type TurnRow = Readonly<{
	kind: "turn";
	id: string;
	depth: 0;
	idx: number;
	role: TurnRole;
	startedAtSec: number;
	endedAtSec: number;
	durationMs: number;
	hasChildren: boolean;
}>;

export type SpanRow = Readonly<{
	kind: "span";
	id: string;
	depth: number;
	name: string;
	vocabulary: SpanVocabulary;
	startedAtSec: number;
	endedAtSec: number;
	durationMs: number;
	hasChildren: boolean;
	parentRowId: string;
	span: SpanResponse;
}>;

export type UntimedGroupRow = Readonly<{
	kind: "untimed-group";
	id: string;
	depth: 0;
	spanCount: number;
	hasChildren: boolean;
}>;

export type TreeRow = TurnRow | SpanRow | UntimedGroupRow;

export type TraceScale = Readonly<{
	startSec: number;
	endSec: number;
	durationSec: number;
}>;
