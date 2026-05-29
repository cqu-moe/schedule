DROP INDEX `users_student_id_unique`;--> statement-breakpoint
ALTER TABLE `users` ADD `auth_user_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `auth_refresh_token` text;--> statement-breakpoint
ALTER TABLE `users` ADD `auth_refresh_issued_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_auth_user_id_unique` ON `users` (`auth_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_password_student_id` ON `users` (`student_id`) WHERE auth_user_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_personal_user_source` ON `subscriptions` (`user_id`,`source_type`) WHERE is_personal = 1;