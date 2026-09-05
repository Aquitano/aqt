CREATE TABLE "artist" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"bio" text,
	"birth_year" integer,
	"death_year" integer,
	"nationality" text,
	"portrait_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "art_group" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"kind" text DEFAULT 'collection' NOT NULL,
	"name" text NOT NULL,
	"tagline" text,
	"description" text,
	"cover_image_url" text,
	"museum_id" text,
	"artist_id" text,
	"theme" jsonb,
	"is_published" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_artwork" (
	"group_id" text NOT NULL,
	"artwork_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "group_artwork_group_id_artwork_id_pk" PRIMARY KEY("group_id","artwork_id")
);
--> statement-breakpoint
CREATE TABLE "museum" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text,
	"description" text,
	"cover_image_url" text,
	"theme" jsonb,
	"is_published" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "placement" (
	"room_id" text NOT NULL,
	"artwork_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"wall" text,
	"wall_offset" real,
	"scale" real,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "placement_room_id_artwork_id_pk" PRIMARY KEY("room_id","artwork_id")
);
--> statement-breakpoint
CREATE TABLE "room" (
	"id" text PRIMARY KEY NOT NULL,
	"museum_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"layout" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artwork" ADD COLUMN "artist_id" text;--> statement-breakpoint
ALTER TABLE "artwork" ADD COLUMN "medium" text;--> statement-breakpoint
ALTER TABLE "artwork" ADD COLUMN "dimensions" text;--> statement-breakpoint
ALTER TABLE "artwork" ADD COLUMN "story" text;--> statement-breakpoint
ALTER TABLE "artwork" ADD COLUMN "fun_facts" jsonb;--> statement-breakpoint
ALTER TABLE "artwork" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "artwork" ADD COLUMN "thumbnail_url" text;--> statement-breakpoint
ALTER TABLE "artwork" ADD COLUMN "image_width" integer;--> statement-breakpoint
ALTER TABLE "artwork" ADD COLUMN "image_height" integer;--> statement-breakpoint
ALTER TABLE "artwork" ADD COLUMN "is_published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "art_group" ADD CONSTRAINT "art_group_museum_id_museum_id_fk" FOREIGN KEY ("museum_id") REFERENCES "public"."museum"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "art_group" ADD CONSTRAINT "art_group_artist_id_artist_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artist"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_artwork" ADD CONSTRAINT "group_artwork_group_id_art_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."art_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_artwork" ADD CONSTRAINT "group_artwork_artwork_id_artwork_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artwork"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_room_id_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_artwork_id_artwork_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artwork"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_museum_id_museum_id_fk" FOREIGN KEY ("museum_id") REFERENCES "public"."museum"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artist_slug_idx" ON "artist" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "art_group_slug_idx" ON "art_group" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "art_group_museum_id_idx" ON "art_group" USING btree ("museum_id");--> statement-breakpoint
CREATE INDEX "art_group_artist_id_idx" ON "art_group" USING btree ("artist_id");--> statement-breakpoint
CREATE INDEX "group_artwork_group_id_idx" ON "group_artwork" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "group_artwork_artwork_id_idx" ON "group_artwork" USING btree ("artwork_id");--> statement-breakpoint
CREATE UNIQUE INDEX "museum_slug_idx" ON "museum" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "placement_room_id_idx" ON "placement" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "placement_artwork_id_idx" ON "placement" USING btree ("artwork_id");--> statement-breakpoint
CREATE INDEX "room_museum_id_idx" ON "room" USING btree ("museum_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_museum_slug_idx" ON "room" USING btree ("museum_id","slug");--> statement-breakpoint
ALTER TABLE "artwork" ADD CONSTRAINT "artwork_artist_id_artist_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artist"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artwork_artist_id_idx" ON "artwork" USING btree ("artist_id");--> statement-breakpoint
CREATE INDEX "artwork_is_published_idx" ON "artwork" USING btree ("is_published");