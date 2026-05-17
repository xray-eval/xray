import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { createQueryClient } from "./api/query-client.ts";
import { Separator } from "./components/ui/separator.tsx";
import { ConversationsList } from "./conversations/conversations.tsx";
import { Inspector } from "./inspector/inspector.tsx";

export function App() {
	// One QueryClient per App instance. `useState` (not `useMemo`) so the same
	// client survives StrictMode's double-invocation in dev. See
	// tkdodo.eu/blog/the-useless-use-callback.
	const [queryClient] = useState(createQueryClient);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
	return (
		<QueryClientProvider client={queryClient}>
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
					{selectedSessionId === null ? (
						<ConversationsList onSelectSession={setSelectedSessionId} />
					) : (
						<Inspector sessionId={selectedSessionId} onBack={() => setSelectedSessionId(null)} />
					)}
				</main>
			</div>
		</QueryClientProvider>
	);
}
