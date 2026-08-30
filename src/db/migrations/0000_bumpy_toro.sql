CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`token_enc` text NOT NULL,
	`base_url` text NOT NULL,
	`owner_user_id` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`paused_until` integer,
	`last_error` text,
	`last_inbound_at` integer,
	`sync_buf` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inbound_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`account_id` text NOT NULL,
	`from_user_id` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`matched_keyword_id` integer,
	`action` text NOT NULL,
	`reply` text
);
--> statement-breakpoint
CREATE INDEX `inbound_log_ts_idx` ON `inbound_log` (`ts`);--> statement-breakpoint
CREATE TABLE `keywords` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` text NOT NULL,
	`keyword` text NOT NULL,
	`match_mode` text NOT NULL,
	`url` text NOT NULL,
	`secret_enc` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `keywords_account_keyword_uq` ON `keywords` (`account_id`,`keyword`);--> statement-breakpoint
CREATE TABLE `login_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`qrcode` text NOT NULL,
	`qrcode_url` text NOT NULL,
	`verify_code` text,
	`bot_id` text,
	`token_enc` text,
	`base_url` text,
	`user_id` text,
	`message` text
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`sendkey_id` integer,
	`account_id` text NOT NULL,
	`peer_user_id` text NOT NULL,
	`title` text NOT NULL,
	`desp` text DEFAULT '' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `peers` (
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`context_token` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `push_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`sendkey_id` integer,
	`account_id` text,
	`peer_user_id` text,
	`title` text NOT NULL,
	`desp` text DEFAULT '' NOT NULL,
	`short` text,
	`extra` text,
	`status` text NOT NULL,
	`error` text,
	`client_id` text,
	`ip` text
);
--> statement-breakpoint
CREATE INDEX `push_log_ts_idx` ON `push_log` (`ts`);--> statement-breakpoint
CREATE TABLE `sendkeys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key_hash` text NOT NULL,
	`account_id` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sendkeys_key_hash_unique` ON `sendkeys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `sendkeys_account_idx` ON `sendkeys` (`account_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
