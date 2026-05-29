PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`encrypted_password` text,
	`auth_user_id` text,
	`auth_refresh_token` text,
	`auth_refresh_issued_at` text,
	`access_token` text,
	`refresh_token` text,
	`token_expires_at` text,
	`calendar_token` text NOT NULL,
	`pending_calendar_token` text,
	`pending_token_expires_at` text,
	`last_login_at` text,
	`last_refresh_at` text,
	`login_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "student_id", "encrypted_password", "auth_user_id", "auth_refresh_token", "auth_refresh_issued_at", "access_token", "refresh_token", "token_expires_at", "calendar_token", "pending_calendar_token", "pending_token_expires_at", "last_login_at", "last_refresh_at", "login_error", "created_at", "updated_at") SELECT "id", "student_id", "encrypted_password", "auth_user_id", "auth_refresh_token", "auth_refresh_issued_at", "access_token", "refresh_token", "token_expires_at", "calendar_token", "pending_calendar_token", "pending_token_expires_at", "last_login_at", "last_refresh_at", "login_error", "created_at", "updated_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_auth_user_id_unique` ON `users` (`auth_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_calendar_token_unique` ON `users` (`calendar_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_pending_calendar_token_unique` ON `users` (`pending_calendar_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_password_student_id` ON `users` (`student_id`) WHERE auth_user_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_personal_user_source` ON `subscriptions` (`user_id`,`source_type`) WHERE is_personal = 1;