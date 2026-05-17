import type { SessionListItem } from "@/server/sessions/sessions.types.ts";

/** Pick the shadcn Badge variant for a session source. */
export function sourceBadgeVariant(source: SessionListItem["source"]): "default" | "secondary" {
	return source === "ingest" ? "default" : "secondary";
}
