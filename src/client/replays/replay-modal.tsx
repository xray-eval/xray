import { useMutation } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { match, P } from "ts-pattern";

import type { ReplayMode, ReplayRunResponse } from "@/server/replays/replays.types.ts";

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
import { ReplayLoadError } from "./errors.ts";

export interface ReplayModalProps {
	sourceSessionId: string;
	onClose: () => void;
	onStarted: (run: ReplayRunResponse) => void;
}

// Webhook URLs may carry auth tokens in query params; localStorage is readable
// by any script on this origin. xray is self-hosted single-user so this is
// acceptable, but worth knowing if you embed xray elsewhere.
const WEBHOOK_STORAGE_KEYS: Record<ReplayMode, string> = {
	text: "xray.replay.webhookUrl",
	realtime: "xray.replay.realtimeWebhookUrl",
};

function readWebhookFromStorage(mode: ReplayMode): string {
	try {
		return window.localStorage.getItem(WEBHOOK_STORAGE_KEYS[mode]) ?? "";
	} catch {
		return "";
	}
}

function writeWebhookToStorage(mode: ReplayMode, url: string): void {
	try {
		window.localStorage.setItem(WEBHOOK_STORAGE_KEYS[mode], url);
	} catch {
		// ignore — form just won't autofill next time
	}
}

function placeholderForMode(mode: ReplayMode): string {
	return match(mode)
		.with("text", () => "https://your-agent.example.com/replay")
		.with("realtime", () => "ws://your-agent-realtime.example.com/")
		.exhaustive();
}

function helpTextForMode(mode: ReplayMode): React.ReactNode {
	return match(mode)
		.with("text", () => (
			<>
				xray POSTs <code className="font-mono">{`{userText, history, recordedToolResults}`}</code>{" "}
				per turn and expects <code className="font-mono">{`{agentText, toolCalls?, ...}`}</code>{" "}
				back.
			</>
		))
		.with("realtime", () => (
			<>
				xray opens one WebSocket per run, streams the source session's recorded audio, and writes
				the agent's audio + transcript per turn boundary. Webhook is responsible for bridging to
				OpenAI Realtime (or any V2V model).
			</>
		))
		.exhaustive();
}

export function ReplayModal({ sourceSessionId, onClose, onStarted }: ReplayModalProps) {
	const urlInputId = useId();
	const modeRadioName = useId();
	const [mode, setMode] = useState<ReplayMode>("text");
	const [webhookUrl, setWebhookUrl] = useState<string>(() => readWebhookFromStorage("text"));

	const onModeChange = (next: ReplayMode): void => {
		setMode(next);
		setWebhookUrl(readWebhookFromStorage(next));
	};

	const mutation = useMutation<ReplayRunResponse, Error, void>({
		mutationFn: () => createReplay({ body: { sourceSessionId, webhookUrl }, mode }),
		onSuccess: (run) => {
			writeWebhookToStorage(mode, webhookUrl);
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
						xray walks the source through your webhook and records the responses as a new session.{" "}
						<span className="font-mono text-xs">{sourceSessionId}</span>
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={submit} className="space-y-5">
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">Mode</legend>
						{/* <fieldset>/<legend> already exposes radiogroup semantics
						    (WAI-ARIA §4.3.11) — don't double-label with role="radiogroup". */}
						<div className="flex gap-3">
							<ModeOption
								id={`${modeRadioName}-text`}
								name={modeRadioName}
								value="text"
								checked={mode === "text"}
								onChange={onModeChange}
								label="Text (HTTP)"
								hint="Per-turn POST"
							/>
							<ModeOption
								id={`${modeRadioName}-realtime`}
								name={modeRadioName}
								value="realtime"
								checked={mode === "realtime"}
								onChange={onModeChange}
								label="Realtime (V2V)"
								hint="One WebSocket, audio in/out"
							/>
						</div>
					</fieldset>

					<div className="space-y-2">
						<label htmlFor={urlInputId} className="text-sm font-medium">
							Webhook URL
						</label>
						<input
							id={urlInputId}
							// `type="text"` (not "url") because realtime URLs use the ws/wss
							// scheme which the browser's built-in url validation rejects.
							// Server-side Valibot is the authoritative validator at the
							// boundary per .claude/rules/boundary-validation.md.
							// inputMode="url" + autoCorrect/autoCapitalize/spellCheck off
							// preserves the iOS URL keyboard and stops mobile keyboards
							// from auto-capitalizing the host into "Https://..." or
							// silently mangling the path segment.
							type="text"
							inputMode="url"
							autoComplete="url"
							autoCorrect="off"
							autoCapitalize="none"
							spellCheck={false}
							required
							autoFocus
							placeholder={placeholderForMode(mode)}
							value={webhookUrl}
							onChange={(e) => setWebhookUrl(e.target.value)}
							className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
						/>
						<p className="text-xs text-muted-foreground">{helpTextForMode(mode)}</p>
					</div>

					{match(mutation)
						.with({ status: "error" }, (m) => <SubmitError error={m.error} />)
						.with({ status: P.union("idle", "pending", "success") }, () => null)
						.exhaustive()}

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

interface ModeOptionProps {
	id: string;
	name: string;
	value: ReplayMode;
	checked: boolean;
	onChange: (mode: ReplayMode) => void;
	label: string;
	hint: string;
}

/**
 * Renders the mutation error in user terms. The server returns structured
 * JSON like `{"error": "invalid_realtime_replay_request", "issues": [...]}`
 * and `ReplayLoadError.message` carries that raw body — useful for debugging
 * but not user-facing. Branch on `status` for the common cases; fall back to
 * the raw message only when we don't recognize the code.
 */
function SubmitError({ error }: { error: Error }) {
	const friendly = match(error)
		.with(P.instanceOf(ReplayLoadError), (e) =>
			match(e.status)
				.with(400, () => "The webhook URL isn't valid for this mode (try ws:// or wss:// for V2V).")
				.with(404, () => "Source session not found — open it again from the list.")
				.with(413, () => "Request body is too large — try a shorter URL.")
				.with(
					P.number.between(500, 599),
					() => "The xray server hit an internal error. Check the container logs.",
				)
				.otherwise(() => e.message),
		)
		.otherwise((e) => e.message);
	return (
		<div
			role="alert"
			className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm"
		>
			<AlertCircle aria-hidden="true" className="mt-0.5 size-4 text-destructive" />
			<div>
				<div className="font-medium">Failed to start replay.</div>
				<div className="break-all text-xs text-muted-foreground">{friendly}</div>
			</div>
		</div>
	);
}

function ModeOption({ id, name, value, checked, onChange, label, hint }: ModeOptionProps) {
	return (
		<label
			htmlFor={id}
			className={`flex-1 cursor-pointer rounded-md border p-3 text-sm ${
				checked ? "border-ring bg-accent/30" : "border-input"
			}`}
		>
			<input
				type="radio"
				id={id}
				name={name}
				value={value}
				checked={checked}
				onChange={() => onChange(value)}
				className="sr-only"
			/>
			<div className="font-medium">{label}</div>
			<div className="text-xs text-muted-foreground">{hint}</div>
		</label>
	);
}
