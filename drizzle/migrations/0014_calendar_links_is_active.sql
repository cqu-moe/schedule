-- issue #89: link-level serving flag for non-default links, reconciled from caps.share.
ALTER TABLE `calendar_links` ADD `is_active` integer NOT NULL DEFAULT 1;
