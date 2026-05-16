CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`provider` text,
	`agent_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`duration_ms` integer,
	CONSTRAINT "sessions_source_ck" CHECK("sessions"."source" IN ('adapter', 'ingest'))
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_started_at` ON `sessions` (`started_at`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn_id` text NOT NULL,
	`idx` integer NOT NULL,
	`name` text NOT NULL,
	`args_json` text NOT NULL,
	`result_json` text,
	`latency_ms` integer,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tool_calls_turn_idx` ON `tool_calls` (`turn_id`,`idx`);--> statement-breakpoint
CREATE UNIQUE INDEX `tool_calls_turn_idx_uk` ON `tool_calls` (`turn_id`,`idx`);--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`idx` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`ts` text NOT NULL,
	`active_node_id` text,
	`edge_fired_id` text,
	`edge_reasoning` text,
	`prompt_seen` text,
	`llm_latency_ms` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "turns_role_ck" CHECK("turns"."role" IN ('user', 'agent', 'tool', 'system'))
);
--> statement-breakpoint
CREATE INDEX `idx_turns_session_idx` ON `turns` (`session_id`,`idx`);--> statement-breakpoint
CREATE UNIQUE INDEX `turns_session_idx_uk` ON `turns` (`session_id`,`idx`);