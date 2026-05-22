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
	CONSTRAINT "replays_lifecycle_state_ck" CHECK("replays"."lifecycle_state" IN ('pending', 'running', 'recording_uploaded', 'analyzing', 'completed', 'failed'))
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
CREATE INDEX `idx_tool_calls_replay` ON `tool_calls` (`replay_id`,`started_at`);