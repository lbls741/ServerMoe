ALTER TABLE `accounts` ADD `warn_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `warn_text` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `warn_lead_sec` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `warned_at` integer;