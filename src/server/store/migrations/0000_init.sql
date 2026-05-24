CREATE TABLE `assertion_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`replay_id` text NOT NULL,
	`turn_idx` integer NOT NULL,
	`assertion_idx` integer NOT NULL,
	`kind` text NOT NULL,
	`params_json` text NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`evaluated_at` text NOT NULL,
	FOREIGN KEY (`replay_id`) REFERENCES `replays`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assertion_results_status_ck" CHECK("assertion_results"."status" IN ('passed', 'failed', 'errored'))
);
--> statement-breakpoint
CREATE INDEX `idx_assertion_results_replay_turn` ON `assertion_results` (`replay_id`,`turn_idx`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`hash` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`turns_json` text NOT NULL,
	`created_at` text NOT NULL,
	`last_run_at` text,
	CONSTRAINT "conversations_hash_ck" CHECK(length("conversations"."hash") = 64)
);
--> statement-breakpoint
CREATE INDEX `idx_conversations_last_run_at` ON `conversations` (`last_run_at`);--> statement-breakpoint
CREATE TABLE `judge_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`replay_id` text NOT NULL,
	`judge_idx` integer NOT NULL,
	`kind` text NOT NULL,
	`params_json` text NOT NULL,
	`status` text NOT NULL,
	`score` integer,
	`reason` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`evaluated_at` text NOT NULL,
	FOREIGN KEY (`replay_id`) REFERENCES `replays`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "judge_results_status_ck" CHECK("judge_results"."status" IN ('passed', 'failed', 'errored')),
	CONSTRAINT "judge_results_score_ck" CHECK("judge_results"."score" IS NULL OR ("judge_results"."score" >= 0 AND "judge_results"."score" <= 100))
);
--> statement-breakpoint
CREATE INDEX `idx_judge_results_replay` ON `judge_results` (`replay_id`);--> statement-breakpoint
CREATE TABLE `model_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`replay_id` text NOT NULL,
	`turn_idx` integer,
	`span_id` text,
	`provider` text,
	`model` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`started_at` text,
	`ended_at` text,
	`latency_ms` integer,
	FOREIGN KEY (`replay_id`) REFERENCES `replays`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_model_usage_replay` ON `model_usage` (`replay_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `replay_evaluations` (
	`replay_id` text PRIMARY KEY NOT NULL,
	`passed` integer NOT NULL,
	`assertions_total` integer NOT NULL,
	`assertions_passed` integer NOT NULL,
	`judges_total` integer NOT NULL,
	`judges_passed` integer NOT NULL,
	`evaluated_at` text NOT NULL,
	FOREIGN KEY (`replay_id`) REFERENCES `replays`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `replay_metrics` (
	`replay_id` text NOT NULL,
	`turn_idx` integer NOT NULL,
	`agent_response_ms` integer,
	`ttft_ms` integer,
	`interrupted` integer NOT NULL,
	`interruption_start_ms` integer,
	PRIMARY KEY(`replay_id`, `turn_idx`),
	FOREIGN KEY (`replay_id`) REFERENCES `replays`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `replay_turns` (
	`replay_id` text NOT NULL,
	`idx` integer NOT NULL,
	`role` text NOT NULL,
	`turn_start_ms` integer NOT NULL,
	`turn_end_ms` integer NOT NULL,
	`voice_start_ms` integer NOT NULL,
	`voice_end_ms` integer NOT NULL,
	PRIMARY KEY(`replay_id`, `idx`),
	FOREIGN KEY (`replay_id`) REFERENCES `replays`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "replay_turns_role_ck" CHECK("replay_turns"."role" IN ('user', 'agent'))
);
--> statement-breakpoint
CREATE INDEX `idx_replay_turns_replay_idx` ON `replay_turns` (`replay_id`,`idx`);--> statement-breakpoint
CREATE TABLE `replays` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_hash` text NOT NULL,
	`lifecycle_state` text NOT NULL,
	`analysis_step` text,
	`failure_reason` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`audio_path` text,
	`run_config_json` text,
	`job_id` text,
	FOREIGN KEY (`conversation_hash`) REFERENCES `conversations`(`hash`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "replays_lifecycle_state_ck" CHECK("replays"."lifecycle_state" IN ('pending', 'running', 'recording_uploaded', 'analyzing', 'completed', 'failed')),
	CONSTRAINT "replays_analysis_step_ck" CHECK("replays"."analysis_step" IS NULL OR "replays"."analysis_step" IN ('vad', 'transcribe', 'metrics', 'evaluate')),
	CONSTRAINT "replays_failure_reason_ck" CHECK("replays"."failure_reason" IS NULL OR "replays"."failure_reason" IN ('stalled', 'timeout', 'explicit_fail', 'max_attempts_exceeded', 'worker_lost', 'upload_failed', 'driver_aborted', 'agent_not_joined', 'audio_missing', 'transcription_failed', 'metrics_failed', 'evaluation_failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_replays_conversation_hash` ON `replays` (`conversation_hash`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_replays_started_at` ON `replays` (`started_at`);--> statement-breakpoint
CREATE TABLE `spans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`replay_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`parent_span_id` text,
	`name` text NOT NULL,
	`vocabulary` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`attributes_json` text NOT NULL,
	FOREIGN KEY (`replay_id`) REFERENCES `replays`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "spans_vocabulary_ck" CHECK("spans"."vocabulary" IN ('xray', 'gen_ai', 'langfuse'))
);
--> statement-breakpoint
CREATE INDEX `idx_spans_replay_started` ON `spans` (`replay_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_spans_trace` ON `spans` (`trace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `spans_replay_span_uk` ON `spans` (`replay_id`,`span_id`);--> statement-breakpoint
CREATE TABLE `speech_segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`replay_id` text NOT NULL,
	`channel` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	FOREIGN KEY (`replay_id`) REFERENCES `replays`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "speech_segments_channel_ck" CHECK("speech_segments"."channel" IN ('user', 'agent'))
);
--> statement-breakpoint
CREATE INDEX `idx_speech_segments_replay_start` ON `speech_segments` (`replay_id`,`start_ms`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`replay_id` text NOT NULL,
	`turn_idx` integer,
	`span_id` text,
	`name` text NOT NULL,
	`args_json` text,
	`result_json` text,
	`started_at` text,
	`ended_at` text,
	`latency_ms` integer,
	FOREIGN KEY (`replay_id`) REFERENCES `replays`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tool_calls_replay` ON `tool_calls` (`replay_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `turn_transcripts` (
	`replay_id` text NOT NULL,
	`turn_idx` integer NOT NULL,
	`text` text NOT NULL,
	`language` text,
	`words_json` text,
	`duration_ms` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	PRIMARY KEY(`replay_id`, `turn_idx`),
	FOREIGN KEY (`replay_id`) REFERENCES `replays`(`id`) ON UPDATE no action ON DELETE cascade
);
