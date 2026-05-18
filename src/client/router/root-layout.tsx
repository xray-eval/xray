import { Outlet } from "@tanstack/react-router";

import { Separator } from "../components/ui/separator.tsx";
import { XrayLogo } from "../components/xray-logo.tsx";

export function RootLayout() {
	return (
		<div className="min-h-dvh">
			<main className="mx-auto max-w-6xl space-y-10 px-6 py-12">
				<header className="space-y-3">
					<div className="flex items-center gap-3">
						<XrayLogo className="size-9 shrink-0 text-foreground" aria-hidden />
						<h1 className="text-3xl font-semibold tracking-tight">xray</h1>
					</div>
					<p className="text-muted-foreground">
						Replay and eval for LiveKit voice agents. Author a Conversation in Python, run it,
						inspect every turn — text, audio, judge, span tree.
					</p>
				</header>
				<Separator />
				<Outlet />
			</main>
		</div>
	);
}
