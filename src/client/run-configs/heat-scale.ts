import type { BetterDirection, MetricRow } from "./metric-rows.ts";
import { METRIC_ROWS } from "./metric-rows.ts";

/**
 * Only metrics with a direction can be shaded — intensity means "better", and
 * a metric the tool refuses to rank (interruption rate, token usage) has no
 * better. Colouring those by magnitude would invent a winner the rest of the
 * UI deliberately declines to name.
 */
export type RankedDirection = Exclude<BetterDirection, "none">;

export interface RankedMetricRow extends MetricRow {
	readonly better: RankedDirection;
}

/**
 * Outcomes before timings. The aggregate table's order is tuned for reading
 * one config's numbers top to bottom; a stack of grids is scanned in order and
 * stops when the reader has an answer, so "did it do the right thing" has to
 * come before "how quickly did it do it".
 */
const GRID_ORDER: readonly string[] = ["judges", "assertions", "pass"];

export function rankedMetricRows(): RankedMetricRow[] {
	const ranked = METRIC_ROWS.filter((row): row is RankedMetricRow => row.better !== "none");
	const rank = (key: string) => {
		const idx = GRID_ORDER.indexOf(key);
		return idx === -1 ? GRID_ORDER.length : idx;
	};
	return ranked.toSorted((a, b) => rank(a.key) - rank(b.key));
}

export interface HeatRange {
	readonly min: number;
	readonly max: number;
	/**
	 * How many cells were measured. Travels with the span because a zero-width
	 * range means two different things — see `heatIntensity`.
	 */
	readonly n: number;
}

/**
 * The span a metric's cells actually cover, so each grid is scaled against its
 * own numbers rather than an absolute axis. A 40ms spread between configs is
 * worth seeing even though every value is "fast".
 */
export function heatRange(values: readonly (number | null)[]): HeatRange | null {
	const measured = values.filter((value): value is number => value !== null);
	const [first] = measured;
	if (first === undefined) return null;
	const span = measured.reduce(
		(range, value) => ({ min: Math.min(range.min, value), max: Math.max(range.max, value) }),
		{ min: first, max: first },
	);
	return { ...span, n: measured.length };
}

/**
 * Where a value sits in its metric's range, as 0..1 with 1 always meaning
 * "best". Callers map that onto opacity, so direction is handled here once
 * instead of at every render site.
 *
 * Null in, null out: a conversation a config never ran is a gap in the grid,
 * and shading it as the worst value would state a result nobody measured.
 */
export function heatIntensity(value: number | null, range: HeatRange, better: RankedDirection) {
	if (value === null) return null;
	// One measured cell is a zero-width span for the same arithmetic reason a
	// tie is, and the two must not render alike: full intensity on the only
	// config whose agent emitted the metric reads as a win it never contested.
	// `bestCellIndex` withholds its marker on exactly this data for exactly this
	// reason — shading is a weaker claim than "best", but it points the same way.
	if (range.n < 2) return null;
	// Every cell tied. Dimming them all against a zero-width span would read as
	// "no data" rather than "no difference".
	if (range.max === range.min) return 1;
	const clamped = Math.min(Math.max(value, range.min), range.max);
	const position = (clamped - range.min) / (range.max - range.min);
	return better === "lower" ? 1 - position : position;
}
