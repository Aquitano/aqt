ALTER TABLE "artist" ADD COLUMN "user_id" text;--> statement-breakpoint
CREATE INDEX "artist_user_id_idx" ON "artist" USING btree ("user_id");