CREATE TABLE `calendar_links` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`token` text NOT NULL,
	`label` text,
	`formats` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_links_token_unique` ON `calendar_links` (`token`);--> statement-breakpoint
CREATE INDEX `idx_calendar_links_subscription_id` ON `calendar_links` (`subscription_id`);--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`source_name` text NOT NULL,
	`session_id` text,
	`session_name` text,
	`semester_start` text,
	`is_personal` integer DEFAULT false NOT NULL,
	`ics_content` text,
	`courses_json` text,
	`exams_json` text,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_subscriptions`("id", "user_id", "source_type", "source_id", "source_name", "session_id", "session_name", "semester_start", "is_personal", "ics_content", "courses_json", "exams_json", "last_synced_at", "created_at", "updated_at") SELECT "id", "user_id", "source_type", "source_id", "source_name", "session_id", "session_name", "semester_start", "is_personal", "ics_content", "courses_json", "exams_json", "last_synced_at", "created_at", "updated_at" FROM `subscriptions`;--> statement-breakpoint
DROP TABLE `subscriptions`;--> statement-breakpoint
ALTER TABLE `__new_subscriptions` RENAME TO `subscriptions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_source_session` ON `subscriptions` (`user_id`,`source_type`,`source_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `idx_subscriptions_user_id` ON `subscriptions` (`user_id`);