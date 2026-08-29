CREATE TABLE `albums` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`cover` text NOT NULL,
	`share_slug` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `albums_share_slug_unique` ON `albums` (`share_slug`);--> statement-breakpoint
CREATE INDEX `albums_owner_id_idx` ON `albums` (`owner_id`);--> statement-breakpoint
CREATE TABLE `photos` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`key` text NOT NULL,
	`thumb_key` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `photos_owner_id_idx` ON `photos` (`owner_id`);--> statement-breakpoint
CREATE TABLE `spreads` (
	`id` text PRIMARY KEY NOT NULL,
	`album_id` text NOT NULL,
	`position` integer NOT NULL,
	`elements` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `spreads_album_id_idx` ON `spreads` (`album_id`);