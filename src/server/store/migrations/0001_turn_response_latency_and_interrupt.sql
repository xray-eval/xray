ALTER TABLE `turns` RENAME COLUMN `llm_latency_ms` TO `response_latency_ms`;--> statement-breakpoint
ALTER TABLE `turns` ADD `interrupted` integer;--> statement-breakpoint
ALTER TABLE `turns` ADD `interrupted_at_ms` integer;