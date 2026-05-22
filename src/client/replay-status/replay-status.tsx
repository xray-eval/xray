import { match } from "ts-pattern";

import { Badge } from "@/client/components/ui/badge.tsx";

import type { ReplaySummaryResponse } from "../api/api.types.ts";

type RunStatusBadgeReplay = Pick<ReplaySummaryResponse, "lifecycle_state" | "failure_reason">;

export function RunStatusBadge({ replay }: { replay: RunStatusBadgeReplay }) {
	return match(replay.lifecycle_state)
		.with("pending", () => <Badge variant="secondary">pending</Badge>)
		.with("running", () => <Badge className="bg-warning text-warning-foreground">running</Badge>)
		.with("recording_uploaded", () => (
			<Badge className="bg-warning text-warning-foreground">recording uploaded</Badge>
		))
		.with("analyzing", () => (
			<Badge className="bg-warning text-warning-foreground">analyzing</Badge>
		))
		.with("completed", () => (
			<Badge className="bg-success text-success-foreground">completed</Badge>
		))
		.with("failed", () => {
			const reason = replay.failure_reason;
			return (
				<Badge
					variant="destructive"
					title={reason ?? ""}
					aria-label={reason !== null ? `failed: ${reason}` : "failed"}
				>
					failed{reason !== null ? `: ${reason}` : ""}
				</Badge>
			);
		})
		.exhaustive();
}
