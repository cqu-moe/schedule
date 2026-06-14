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
-- v2 整库重建（设计 §4/§10）：旧 subscriptions 数据刻意不迁移。旧行的 user_id 是 v1 用户 id（非 auth user.id），
-- 且无对应 calendar_links，迁移后会成为不可达孤儿行；故移除 Drizzle 默认生成的 INSERT...SELECT 数据拷贝，新表从空开始。
--> statement-breakpoint
DROP TABLE `subscriptions`;--> statement-breakpoint
ALTER TABLE `__new_subscriptions` RENAME TO `subscriptions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_source_session` ON `subscriptions` (`user_id`,`source_type`,`source_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `idx_subscriptions_user_id` ON `subscriptions` (`user_id`);