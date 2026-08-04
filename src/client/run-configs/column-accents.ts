/**
 * Per-config identity colours, shared by the picker's selection rail and the
 * comparison table's columns. Both index by position in the selection, so a
 * config wears the same colour in the place you pick it and the place you read
 * its numbers.
 *
 * Used only as a stripe, never on the numbers themselves — the data stays
 * achromatic so "best" remains the single visual ranking signal.
 */
export const COLUMN_ACCENTS = [
	"bg-chart-1",
	"bg-chart-2",
	"bg-chart-3",
	"bg-chart-4",
	"bg-chart-5",
] as const;

/** Wraps past five: the comparison cap is eight and the theme has five tokens. */
export function accentAt(index: number): string {
	return COLUMN_ACCENTS[index % COLUMN_ACCENTS.length] ?? COLUMN_ACCENTS[0];
}
