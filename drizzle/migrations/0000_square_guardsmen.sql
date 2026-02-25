CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`source_name` text NOT NULL,
	`calendar_token` text NOT NULL,
	`session_id` text,
	`session_name` text,
	`semester_start` text,
	`is_personal` integer DEFAULT false NOT NULL,
	`ics_content` text,
	`courses_json` text,
	`exams_json` text,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_calendar_token_unique` ON `subscriptions` (`calendar_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_source_session` ON `subscriptions` (`user_id`,`source_type`,`source_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`encrypted_password` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`token_expires_at` text,
	`calendar_token` text NOT NULL,
	`last_login_at` text,
	`last_refresh_at` text,
	`login_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_student_id_unique` ON `users` (`student_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_calendar_token_unique` ON `users` (`calendar_token`);