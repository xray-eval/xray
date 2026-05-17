CREATE TABLE `replay_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_session_id` text NOT NULL,
	`target_session_id` text NOT NULL,
	`status` text NOT NULL,
	`webhook_url` text NOT NULL,
	`progress_completed` integer DEFAULT 0 NOT NULL,
	`progress_total` integer NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`error` text,
	FOREIGN KEY (`source_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "replay_runs_status_ck" CHECK("replay_runs"."status" IN ('pending', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `replay_runs_target_session_id_unique` ON `replay_runs` (`target_session_id`);--> statement-breakpoint
CREATE INDEX `idx_replay_runs_source` ON `replay_runs` (`source_session_id`);--> statement-breakpoint
CREATE INDEX `idx_replay_runs_started_at` ON `replay_runs` (`started_at`);