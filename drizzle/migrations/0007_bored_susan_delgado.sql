ALTER TABLE `subscriptions` ADD `sync_status` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `sync_run_id` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `sync_trigger` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `sync_requested_at` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `sync_started_at` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `sync_finished_at` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `sync_error_code` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `sync_error_message` text;