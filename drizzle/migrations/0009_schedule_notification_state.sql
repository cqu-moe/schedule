CREATE TABLE `notification_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`snapshot_json` text,
	`snapshot_hash` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
