import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { Button } from "../components/ui/button.tsx";

export function BackToSessionsLink() {
	// `asChild` so the Button renders as the <Link>'s <a>, not a <button>
	// nested inside one. Same shadcn Slot pattern is used in not-found.tsx.
	return (
		<Button asChild variant="ghost" size="sm">
			<Link to="/">
				<ArrowLeft />
				All sessions
			</Link>
		</Button>
	);
}
