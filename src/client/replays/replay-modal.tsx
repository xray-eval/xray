import { useMutation } from "@tanstack/react-query";
import { AlertCircle, Loader2, X } from "lucide-react";
import { useId, useState } from "react";
import { match } from "ts-pattern";

import type { ReplayRunResponse } from "@/server/replays/replays.types.ts";

import { createReplay } from "../api/replays-api.ts";
import { Button } from "../components/ui/button.tsx";

export interface ReplayModalProps {
	sourceSessionId: string;
	apiBase?: string;
	onClose: () => void;
	onStarted: (run: ReplayRunResponse) => void;
}

// Webhook URLs may carry auth tokens in query params; localStorage is readable
// by any script on this origin. xray is self-hosted single-user so this is
// acceptable, but worth knowing if you embed xray elsewhere.
const WEBHOOK_STORAGE_KEY = "xray.replay.webhookUrl";

function readWebhookFromStorage(): string {
	try {
		return window.localStorage.getItem(WEBHOOK_STORAGE_KEY) ?? "";
	} catch {
		return "";
	}
}

function writeWebhookToStorage(url: string): void {
	try {
		window.localStorage.setItem(WEBHOOK_STORAGE_KEY, url);
	} catch {
		// ignore — form just won't autofill next time
	}
}

export function ReplayModal({ sourceSessionId, apiBase, onClose, onStarted }: ReplayModalProps) {
	const titleId = useId();
	const urlInputId = useId();
	const [webhookUrl, setWebhookUrl] = useState<string>(readWebhookFromStorage);

	const mutation = useMutation<ReplayRunResponse, Error, void>({
		mutationFn: () =>
			createReplay({
				body: { sourceSessionId, webhookUrl },
				...(apiBase !== undefined ? { apiBase } : {}),
			}),
		onSuccess: (run) => {
			writeWebhookToStorage(webhookUrl);
			onStarted(run);
		},
	});

	const submit = (e: React.FormEvent) => {
		e.preventDefault();
		mutation.mutate();
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
			<button
				type="button"
				aria-label="Close dialog"
				onClick={onClose}
				className="absolute inset-0 size-full cursor-default"
				tabIndex={-1}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				className="relative w-full max-w-lg rounded-lg border bg-background p-6 shadow-lg"
			>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close modal"
					className="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
				>
					<X className="size-4" />
				</button>

				<h2 id={titleId} className="text-lg font-semibold tracking-tight">
					Replay session
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					xray walks the user-side inputs through your webhook and records the responses as a new
					session. <span className="font-mono text-xs">{sourceSessionId}</span>
				</p>

				<form onSubmit={submit} className="mt-6 space-y-5">
					<div className="space-y-2">
						<label htmlFor={urlInputId} className="text-sm font-medium">
							Webhook URL
						</label>
						<input
							id={urlInputId}
							type="url"
							required
							placeholder="https://your-agent.example.com/replay"
							value={webhookUrl}
							onChange={(e) => setWebhookUrl(e.target.value)}
							className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
						/>
						<p className="text-xs text-muted-foreground">
							xray POSTs{" "}
							<code className="font-mono">{`{userText, history, recordedToolResults}`}</code> here
							and expects <code className="font-mono">{`{agentText, toolCalls?, ...}`}</code> back.
						</p>
					</div>

					{match(mutation)
						.with({ status: "error" }, (m) => (
							<div
								role="alert"
								className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm"
							>
								<AlertCircle className="mt-0.5 size-4 text-destructive" />
								<div>
									<div className="font-medium">Failed to start replay.</div>
									<div className="break-all text-xs text-muted-foreground">{m.error.message}</div>
								</div>
							</div>
						))
						.otherwise(() => null)}

					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={mutation.isPending || webhookUrl.length === 0}>
							{mutation.isPending && <Loader2 className="size-4 animate-spin" />}
							{mutation.isPending ? "Starting…" : "Run replay"}
						</Button>
					</div>
				</form>
			</div>
		</div>
	);
}
