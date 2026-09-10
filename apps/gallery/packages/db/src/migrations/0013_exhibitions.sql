CREATE TABLE IF NOT EXISTS "exhibition" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"kind" text DEFAULT 'custom' NOT NULL,
	"name" text NOT NULL,
	"tagline" text,
	"description" text,
	"cover_image_url" text,
	"cover_artwork_id" text,
	"artist_id" text,
	"created_by" text,
	"theme" jsonb,
	"is_published" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exhibition" DROP CONSTRAINT IF EXISTS "exhibition_cover_artwork_id_artwork_id_fk";--> statement-breakpoint
ALTER TABLE "exhibition" ADD CONSTRAINT "exhibition_cover_artwork_id_artwork_id_fk" FOREIGN KEY ("cover_artwork_id") REFERENCES "public"."artwork"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exhibition" DROP CONSTRAINT IF EXISTS "exhibition_artist_id_artist_id_fk";--> statement-breakpoint
ALTER TABLE "exhibition" ADD CONSTRAINT "exhibition_artist_id_artist_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artist"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "exhibition_slug_idx" ON "exhibition" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exhibition_created_by_idx" ON "exhibition" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exhibition_artist_id_idx" ON "exhibition" USING btree ("artist_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exhibition_kind_idx" ON "exhibition" USING btree ("kind");--> statement-breakpoint
ALTER TABLE "placement" ADD COLUMN IF NOT EXISTS "note" text;--> statement-breakpoint
ALTER TABLE "room" ADD COLUMN IF NOT EXISTS "exhibition_id" text;--> statement-breakpoint
-- Rooms created for former groups and collections have no museum; the
-- column goes away once every room points at an exhibition.
ALTER TABLE "room" ALTER COLUMN "museum_id" DROP NOT NULL;--> statement-breakpoint
-- Multi-room museums keep their id and rooms; they simply become exhibitions.
INSERT INTO "exhibition" ("id", "slug", "kind", "name", "tagline", "description", "cover_image_url", "cover_artwork_id", "artist_id", "created_by", "theme", "is_published", "sort_order", "created_at", "updated_at")
SELECT m."id", m."slug", 'exhibition', m."name", m."tagline", m."description", m."cover_image_url", m."cover_artwork_id", NULL, m."created_by", m."theme", m."is_published", m."sort_order", m."created_at", m."updated_at"
FROM "museum" m
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
UPDATE "room" SET "exhibition_id" = "museum_id" WHERE "exhibition_id" IS NULL;--> statement-breakpoint
-- Single-room galleries (art_group) become exhibitions with one "main" room
-- hanging the former group_artwork rows. Museum and group slugs were unique
-- per table only, so a group whose slug a museum already holds gets suffixed.
INSERT INTO "exhibition" ("id", "slug", "kind", "name", "tagline", "description", "cover_image_url", "cover_artwork_id", "artist_id", "created_by", "theme", "is_published", "sort_order", "created_at", "updated_at")
SELECT g."id",
	CASE WHEN EXISTS (SELECT 1 FROM "museum" m WHERE m."slug" = g."slug") THEN g."slug" || '-' || left(g."id", 8) ELSE g."slug" END,
	g."kind", g."name", g."tagline", g."description", g."cover_image_url", g."cover_artwork_id", g."artist_id", g."created_by", g."theme", g."is_published", g."sort_order", g."created_at", g."updated_at"
FROM "art_group" g
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "room" ("id", "exhibition_id", "slug", "name", "description", "layout", "sort_order", "created_at", "updated_at")
SELECT 'room-' || g."id", g."id", 'main', g."name", NULL, NULL, 0, g."created_at", g."updated_at"
FROM "art_group" g
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "placement" ("room_id", "artwork_id", "position", "wall", "wall_offset", "scale", "note", "created_at")
SELECT 'room-' || ga."group_id", ga."artwork_id", ga."position", ga."wall", ga."wall_offset", ga."scale", NULL, ga."created_at"
FROM "group_artwork" ga
ON CONFLICT ("room_id", "artwork_id") DO NOTHING;--> statement-breakpoint
-- Journal collections become private (never published) exhibitions of kind
-- "personal". Their slugs were unique per user only; the id prefix makes them
-- globally unique.
INSERT INTO "exhibition" ("id", "slug", "kind", "name", "tagline", "description", "cover_image_url", "cover_artwork_id", "artist_id", "created_by", "theme", "is_published", "sort_order", "created_at", "updated_at")
SELECT pc."id", pc."slug" || '-' || left(pc."id", 8), 'personal', pc."name", NULL, pc."description", NULL, pc."cover_artwork_id", NULL, pc."user_id", NULL, false, 0, pc."created_at", pc."updated_at"
FROM "personal_collection" pc
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "room" ("id", "exhibition_id", "slug", "name", "description", "layout", "sort_order", "created_at", "updated_at")
SELECT 'room-' || pc."id", pc."id", 'main', pc."name", NULL, NULL, 0, pc."created_at", pc."updated_at"
FROM "personal_collection" pc
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "placement" ("room_id", "artwork_id", "position", "wall", "wall_offset", "scale", "note", "created_at")
SELECT 'room-' || pca."collection_id", pca."artwork_id", pca."position", NULL, NULL, NULL, pca."note", now()
FROM "personal_collection_artwork" pca
ON CONFLICT ("room_id", "artwork_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "room" ALTER COLUMN "exhibition_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "room" DROP CONSTRAINT IF EXISTS "room_museum_id_museum_id_fk";--> statement-breakpoint
DROP INDEX IF EXISTS "room_museum_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "room_museum_slug_idx";--> statement-breakpoint
ALTER TABLE "room" DROP CONSTRAINT IF EXISTS "room_exhibition_id_exhibition_id_fk";--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_exhibition_id_exhibition_id_fk" FOREIGN KEY ("exhibition_id") REFERENCES "public"."exhibition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_exhibition_id_idx" ON "room" USING btree ("exhibition_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "room_exhibition_slug_idx" ON "room" USING btree ("exhibition_id","slug");--> statement-breakpoint
ALTER TABLE "room" DROP COLUMN IF EXISTS "museum_id";--> statement-breakpoint
UPDATE "museum_stat" SET "entity_kind" = 'exhibition' WHERE "entity_kind" <> 'exhibition';--> statement-breakpoint
DROP TABLE IF EXISTS "group_artwork" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "art_group" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "museum" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "personal_collection_artwork" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "personal_collection" CASCADE;
