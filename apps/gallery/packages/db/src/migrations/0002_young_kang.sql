ALTER TABLE "art_group" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "art_group" ADD CONSTRAINT "art_group_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "art_group_created_by_idx" ON "art_group" USING btree ("created_by");