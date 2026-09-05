ALTER TABLE "museum" ADD COLUMN "cover_artwork_id" text;--> statement-breakpoint
ALTER TABLE "museum" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "museum" ADD CONSTRAINT "museum_cover_artwork_id_artwork_id_fk" FOREIGN KEY ("cover_artwork_id") REFERENCES "public"."artwork"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "museum_created_by_idx" ON "museum" USING btree ("created_by");