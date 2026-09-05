CREATE TABLE `spread_photos` (
	`spread_id` text NOT NULL,
	`photo_id` text NOT NULL,
	PRIMARY KEY(`spread_id`, `photo_id`),
	FOREIGN KEY (`spread_id`) REFERENCES `spreads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `spread_photos_photo_id_idx` ON `spread_photos` (`photo_id`);--> statement-breakpoint
ALTER TABLE `photos` ADD `taken_at` integer;--> statement-breakpoint
INSERT INTO `spread_photos` (`spread_id`, `photo_id`)
SELECT DISTINCT s.`id`, json_extract(e.value, '$.photoId')
FROM `spreads` s, json_each(s.`elements`) e
WHERE json_extract(e.value, '$.kind') = 'photo';
