CREATE TABLE `conversations` (
	`id` text NOT NULL,
	`version` text NOT NULL,
	`turns_json` text NOT NULL,
	`title` text,
	`created_at` text NOT NULL,
	CONSTRAINT `conversations_pk` PRIMARY KEY(`id`, `version`)
);
--> statement-breakpoint
CREATE INDEX `idx_conversations_id_created_at` ON `conversations` (`id`,`created_at`);--> statement-breakpoint
CREATE TABLE `replays` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`conversation_version` text NOT NULL,
	`status` text NOT NULL,
	`failure_reason` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`audio_path` text,
	`transcript` text,
	CONSTRAINT "replays_status_ck" CHECK("replays"."status" IN ('running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_replays_conversation` ON `replays` (`conversation_id`,`conversation_version`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_replays_started_at` ON `replays` (`started_at`);--> statement-breakpoint
CREATE TABLE `replay_meta` (
	`replay_id` text PRIMARY KEY NOT NULL,
	`modality` text DEFAULT 'voice' NOT NULL,
	`run_config_json` text,
	`judge_status` text,
	`judge_score` integer,
	`judge_reason` text,
	`judge_error` text,
	FOREIGN KEY (`replay_id`) REFERENCES `replays`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "replay_meta_modality_ck" CHECK("replay_meta"."modality" IN ('voice'))
);
--> statement-breakpoint
CREATE TABLE `replay_turns` (
	`replay_id` text NOT NULL,
	`idx` integer NOT NULL,
	`role` text NOT NULL,
	`key` text,
	`started_at` text,
	`ended_at` text,
	`transcript` text,
	`audio_path` text,
	FOREIGN KEY (`replay_id`) REFERENCES `replays`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `replay_turns_pk` PRIMARY KEY(`replay_id`, `idx`),
	CONSTRAINT "replay_turns_role_ck" CHECK("replay_turns"."role" IN ('user', 'agent'))
);
--> statement-breakpoint
CREATE INDEX `idx_replay_turns_replay_idx` ON `replay_turns` (`replay_id`,`idx`);--> statement-breakpoint
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
CREATE TABLE `assertions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`replay_id` text NOT NULL,
	`turn_idx` integer NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`replay_id`) REFERENCES `replays`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assertions_status_ck" CHECK("assertions"."status" IN ('passed', 'failed', 'errored'))
);
--> statement-breakpoint
CREATE INDEX `idx_assertions_replay_turn` ON `assertions` (`replay_id`,`turn_idx`);--> statement-breakpoint
CREATE UNIQUE INDEX `assertions_replay_turn_name_uk` ON `assertions` (`replay_id`,`turn_idx`,`name`);
