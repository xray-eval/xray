import { match } from "ts-pattern";

import type { ReplayRunResponse } from "@/server/replays/replays.types.ts";

import { Badge } from "../components/ui/badge.tsx";

export function ReplayStatusBadge({ status }: { status: ReplayRunResponse["status"] }) {
	return match(status)
		.with("pending", () => <Badge variant="outline">pending</Badge>)
		.with("running", () => <Badge variant="secondary">running</Badge>)
		.with("completed", () => <Badge variant="default">completed</Badge>)
		.with("failed", () => <Badge variant="destructive">failed</Badge>)
		.exhaustive();
}
