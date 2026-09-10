ALTER TABLE "personal_collection" ADD COLUMN "cover_artwork_id" text;--> statement-breakpoint
ALTER TABLE "personal_collection_artwork" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "personal_collection" ADD CONSTRAINT "personal_collection_cover_artwork_id_artwork_id_fk" FOREIGN KEY ("cover_artwork_id") REFERENCES "public"."artwork"("id") ON DELETE set null ON UPDATE no action;