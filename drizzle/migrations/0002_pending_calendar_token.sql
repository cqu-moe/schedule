ALTER TABLE `users` ADD `pending_calendar_token` text;--> statement-breakpoint
ALTER TABLE `users` ADD `pending_token_expires_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_pending_calendar_token_unique` ON `users` (`pending_calendar_token`);
