ALTER TABLE "artwork" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "group_artwork" ADD COLUMN "wall" text;--> statement-breakpoint
ALTER TABLE "group_artwork" ADD COLUMN "wall_offset" real;--> statement-breakpoint
ALTER TABLE "group_artwork" ADD COLUMN "scale" real;--> statement-breakpoint
CREATE INDEX "artwork_deleted_at_idx" ON "artwork" USING btree ("deleted_at");