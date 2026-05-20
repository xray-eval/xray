import { AlertTriangle, Check, X } from "lucide-react";
import { match } from "ts-pattern";

import { Badge } from "@/client/components/ui/badge.tsx";

import type { ReplayDetailResponse, ReplaySummaryResponse } from "../api/api.types.ts";

type RunStatusBadgeReplay = Pick<ReplaySummaryResponse, "status" | "failure_reason">;

export function RunStatusBadge({ replay }: { replay: RunStatusBadgeReplay }) {
	return match(replay.status)
		.with("running", () => <Badge className="bg-warning text-warning-foreground">running</Badge>)
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

export function JudgeStatusBadge({
	status,
	score,
}: {
	status: NonNullable<ReplayDetailResponse["judge"]["status"]>;
	score: number | null;
}) {
	const scoreSuffix = score !== null ? <span className="tabular-nums"> ({score})</span> : null;
	return match(status)
		.with("passed", () => (
			<Badge className="bg-success text-success-foreground">
				<Check className="size-3" strokeWidth={3} aria-hidden /> passed{scoreSuffix}
			</Badge>
		))
		.with("failed", () => (
			<Badge variant="destructive">
				<X className="size-3" strokeWidth={3} aria-hidden /> failed{scoreSuffix}
			</Badge>
		))
		.with("errored", () => (
			<Badge className="bg-warning text-warning-foreground">
				<AlertTriangle className="size-3" strokeWidth={2.5} aria-hidden /> errored{scoreSuffix}
			</Badge>
		))
		.with("pending", () => <Badge variant="secondary">pending{scoreSuffix}</Badge>)
		.exhaustive();
}
