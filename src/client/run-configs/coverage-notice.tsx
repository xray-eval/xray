import type { CompareRunConfigsResponse, ConversationScope } from "@/client/api/api.types.ts";
import { Button } from "@/client/components/ui/button.tsx";

/**
 * The fair-comparison guardrail. When the selected configs didn't all run the
 * same conversations, an average over "all ran" is an average over different
 * workloads — so say it in words and offer the one-click fix, rather than
 * leaving the user to notice a coverage number they weren't looking at.
 */
export function CoverageNotice({
	comparison,
	scope,
	onChangeScope,
}: {
	comparison: CompareRunConfigsResponse;
	scope: ConversationScope;
	onChangeScope: (scope: ConversationScope) => void;
}) {
	const uneven = comparison.groups.some(
		(group) => group.coverage.conversations < comparison.union_conversations,
	);
	if (!uneven) return null;

	// Checked before the scope split because an empty intersection is a dead end
	// in both directions: every cell below is "—" with n=0. Under `union` that
	// means the one-click fix would only make the matrix emptier; under
	// `intersection` the user is already standing in it — reached by the mode
	// toggle or a pasted link — and "comparing the 0 conversations every config
	// ran" would describe that blank matrix as a result.
	if (comparison.intersection_conversations === 0) {
		return (
			<div
				role="status"
				className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
			>
				<p>
					These configs have no conversations in common, so{" "}
					{scope === "intersection"
						? "there is nothing left to compare them on"
						: "the numbers below describe entirely different workloads and can't be compared directly"}
					. Run them over the same conversations to get a fair comparison.
				</p>
				{scope === "intersection" && (
					<Button variant="outline" size="sm" onClick={() => onChangeScope("union")}>
						Show all runs
					</Button>
				)}
			</div>
		);
	}

	if (scope === "intersection") {
		return (
			<p
				role="status"
				className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground"
			>
				Comparing the {comparison.intersection_conversations} conversation
				{comparison.intersection_conversations === 1 ? "" : "s"} every selected config ran. Runs
				outside that shared set are excluded from these numbers.
			</p>
		);
	}
	return (
		<div
			role="status"
			className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
		>
			<p>
				These configs didn't all run the same conversations, so the averages cover different
				workloads. Only {comparison.intersection_conversations} of {comparison.union_conversations}{" "}
				conversations were run by every config.
			</p>
			<Button variant="outline" size="sm" onClick={() => onChangeScope("intersection")}>
				Compare shared only
			</Button>
		</div>
	);
}
