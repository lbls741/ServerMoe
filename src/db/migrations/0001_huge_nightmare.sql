ALTER TABLE `login_sessions` ADD `refresh_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `login_sessions` ADD `poll_host` text;