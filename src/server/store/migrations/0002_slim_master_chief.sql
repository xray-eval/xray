ALTER TABLE `model_usage` ADD `ttft_ms` integer;--> statement-breakpoint
ALTER TABLE `model_usage` DROP COLUMN `turn_idx`;--> statement-breakpoint
ALTER TABLE `replays` ADD `recording_started_at` text;--> statement-breakpoint
ALTER TABLE `replay_metrics` DROP COLUMN `ttft_ms`;--> statement-breakpoint
ALTER TABLE `tool_calls` DROP COLUMN `turn_idx`;