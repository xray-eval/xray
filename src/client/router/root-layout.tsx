import { Outlet } from "@tanstack/react-router";

import { Separator } from "../components/ui/separator.tsx";

export function RootLayout() {
	return (
		<div className="min-h-dvh">
			<main className="mx-auto max-w-3xl space-y-10 px-6 py-12">
				<header className="space-y-2">
					<h1 className="text-3xl font-semibold tracking-tight">xray</h1>
					<p className="text-muted-foreground">
						Voice-agent debugger — inspect every turn of every conversation. Read what your agent
						heard, see what it decided, find where it went sideways.
					</p>
				</header>
				<Separator />
				<Outlet />
			</main>
		</div>
	);
}
