-- issue #91: migration tooling was removed in #107; the backup snapshots have no
-- reader or writer left, so drop the table instead of adding a retention job.
DROP TABLE IF EXISTS `personal_subscription_migration_backups`;
