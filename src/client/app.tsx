import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { match } from "ts-pattern";

import { createQueryClient } from "./api/query-client.ts";
import { Separator } from "./components/ui/separator.tsx";
import { ConversationsList } from "./conversations/conversations.tsx";
import { Inspector } from "./inspector/inspector.tsx";
import { ReplayModal } from "./replays/replay-modal.tsx";
import { ReplayView } from "./replays/replay-view.tsx";

type View =
	| { kind: "list" }
	| { kind: "inspector"; sessionId: string }
	| { kind: "replay"; replayId: string };

export function App() {
	// `useState` (not `useMemo`) so the QueryClient survives StrictMode's
	// double-invocation in dev. See tkdodo.eu/blog/the-useless-use-callback.
	const [queryClient] = useState(createQueryClient);
	const [view, setView] = useState<View>({ kind: "list" });
	const [modalSource, setModalSource] = useState<string | null>(null);

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
					{match(view)
						.with({ kind: "list" }, () => (
							<ConversationsList
								onSelectSession={(id) => setView({ kind: "inspector", sessionId: id })}
								onReplaySession={(id) => setModalSource(id)}
							/>
						))
						.with({ kind: "inspector" }, (v) => (
							<Inspector sessionId={v.sessionId} onBack={() => setView({ kind: "list" })} />
						))
						.with({ kind: "replay" }, (v) => (
							<ReplayView replayId={v.replayId} onBack={() => setView({ kind: "list" })} />
						))
						.exhaustive()}
				</main>
				{modalSource !== null && (
					<ReplayModal
						sourceSessionId={modalSource}
						onClose={() => setModalSource(null)}
						onStarted={(run) => {
							setModalSource(null);
							setView({ kind: "replay", replayId: run.id });
						}}
					/>
				)}
			</div>
		</QueryClientProvider>
	);
}
