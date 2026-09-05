CREATE TABLE `ingest_leases` (
	`account_id` text PRIMARY KEY NOT NULL,
	`leased_until` integer NOT NULL,
	`last_poll_at` integer
);
--> statement-breakpoint
CREATE TABLE `rate_buckets` (
	`key` text PRIMARY KEY NOT NULL,
	`tokens` real NOT NULL,
	`last` integer NOT NULL
);
