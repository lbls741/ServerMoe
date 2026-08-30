CREATE TABLE `mail_configs` (
	`account_id` text PRIMARY KEY NOT NULL,
	`imap_enc` text NOT NULL,
	`smtp_enc` text NOT NULL,
	`from` text,
	`poll_sec` integer DEFAULT 60 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`uid_validity` text,
	`last_uid` integer,
	`last_poll_at` integer,
	`last_error` text
);
