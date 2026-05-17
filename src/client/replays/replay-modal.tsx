import { useMutation } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import { useId, useState } from "react";

import type { ReplayRunResponse } from "@/server/replays/replays.types.ts";

import { createReplay } from "../api/replays-api.ts";
import { Button } from "../components/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../components/ui/dialog.tsx";

export interface ReplayModalProps {
	sourceSessionId: string;
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

export function ReplayModal({ sourceSessionId, onClose, onStarted }: ReplayModalProps) {
	const urlInputId = useId();
	const [webhookUrl, setWebhookUrl] = useState<string>(readWebhookFromStorage);

	const mutation = useMutation<ReplayRunResponse, Error, void>({
		mutationFn: () => createReplay({ body: { sourceSessionId, webhookUrl } }),
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
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Replay session</DialogTitle>
					<DialogDescription>
						xray walks the user-side inputs through your webhook and records the responses as a new
						session. <span className="font-mono text-xs">{sourceSessionId}</span>
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={submit} className="space-y-5">
					<div className="space-y-2">
						<label htmlFor={urlInputId} className="text-sm font-medium">
							Webhook URL
						</label>
						<input
							id={urlInputId}
							type="url"
							required
							autoFocus
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

					{mutation.isError && (
						<div
							role="alert"
							className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm"
						>
							<AlertCircle className="mt-0.5 size-4 text-destructive" />
							<div>
								<div className="font-medium">Failed to start replay.</div>
								<div className="break-all text-xs text-muted-foreground">
									{mutation.error.message}
								</div>
							</div>
						</div>
					)}

					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={mutation.isPending || webhookUrl.length === 0}>
							{mutation.isPending && <Loader2 className="size-4 animate-spin" />}
							{mutation.isPending ? "Starting…" : "Run replay"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
