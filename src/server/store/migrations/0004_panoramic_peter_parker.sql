CREATE TABLE `run_configs` (
	`hash` text PRIMARY KEY NOT NULL,
	`name` text,
	`config_json` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "run_configs_hash_ck" CHECK(length("run_configs"."hash") = 64)
);
--> statement-breakpoint
ALTER TABLE `replays` ADD `run_config_hash` text REFERENCES run_configs(hash);--> statement-breakpoint
CREATE INDEX `idx_replays_run_config_hash` ON `replays` (`run_config_hash`,`started_at`);