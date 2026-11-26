CREATE TABLE `sleep_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`wake_date` text NOT NULL,
	`asleep_minutes` integer NOT NULL,
	`has_stages` integer NOT NULL,
	CONSTRAINT "sleep_sessions_end_after_start" CHECK("sleep_sessions"."end_at" > "sleep_sessions"."start_at"),
	CONSTRAINT "sleep_sessions_wake_date_format" CHECK("sleep_sessions"."wake_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "sleep_sessions_asleep_positive" CHECK("sleep_sessions"."asleep_minutes" > 0),
	CONSTRAINT "sleep_sessions_has_stages_bool" CHECK("sleep_sessions"."has_stages" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `sleep_sessions_wake_date_idx` ON `sleep_sessions` (`wake_date`);--> statement-breakpoint
CREATE INDEX `sleep_sessions_end_at_idx` ON `sleep_sessions` (`end_at`);--> statement-breakpoint
CREATE TABLE `sleep_stages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`stage` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sleep_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sleep_stages_stage_values" CHECK("sleep_stages"."stage" IN ('awake', 'light', 'deep', 'rem', 'unspecified')),
	CONSTRAINT "sleep_stages_end_after_start" CHECK("sleep_stages"."end_at" > "sleep_stages"."start_at")
);
--> statement-breakpoint
CREATE INDEX `sleep_stages_session_id_idx` ON `sleep_stages` (`session_id`);--> statement-breakpoint
CREATE TABLE `sleep_sync_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_synced_at` integer NOT NULL,
	CONSTRAINT "sleep_sync_state_single_row" CHECK("sleep_sync_state"."id" = 1)
);
