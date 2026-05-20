import { Link, Outlet } from "@tanstack/react-router";

import { XrayLogo } from "../components/xray-logo.tsx";

export function RootLayout() {
	return (
		<div className="min-h-dvh bg-background text-foreground antialiased">
			<header className="border-b border-border/60">
				<div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
					<Link
						to="/"
						className="group flex items-center gap-2.5 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
					>
						<XrayLogo
							className="size-5 shrink-0 text-foreground transition-transform group-hover:rotate-45"
							aria-hidden
						/>
						<h1 className="text-sm font-semibold tracking-tight">xray</h1>
					</Link>
					<span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
						voice-agent debugger and tester
					</span>
				</div>
			</header>
			<main className="mx-auto max-w-6xl px-6 py-10 sm:py-14">
				<Outlet />
			</main>
		</div>
	);
}
