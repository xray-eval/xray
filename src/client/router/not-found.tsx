import { Link } from "@tanstack/react-router";

import { Button } from "../components/ui/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../components/ui/card.tsx";

export function NotFoundView() {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Page not found.</CardTitle>
				<CardDescription>The URL doesn't match any view in xray.</CardDescription>
			</CardHeader>
			<CardContent className="flex justify-end">
				{/* `asChild` so the Button renders as the <Link>'s <a>, not a <button> nested in one. */}
				<Button asChild size="sm" variant="outline">
					<Link to="/">Back to sessions</Link>
				</Button>
			</CardContent>
		</Card>
	);
}
