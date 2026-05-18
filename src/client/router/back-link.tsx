import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { Button } from "../components/ui/button.tsx";

export function BackToSessionsLink() {
	return (
		<Button asChild variant="outline" size="sm">
			<Link to="/">
				<ArrowLeft />
				All sessions
			</Link>
		</Button>
	);
}

export function BackToReplaysLink({ sourceSessionId }: { sourceSessionId: string }) {
	return (
		<Button asChild variant="outline" size="sm">
			<Link
				to="/sessions/$sessionId"
				params={{ sessionId: sourceSessionId }}
				search={{ tab: "replays" }}
			>
				<ArrowLeft />
				All replays
			</Link>
		</Button>
	);
}
