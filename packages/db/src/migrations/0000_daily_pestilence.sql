CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artwork" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"artist" text,
	"artwork_type" text DEFAULT 'other' NOT NULL,
	"year" text,
	"seen_at" timestamp,
	"rating" integer,
	"review" text,
	"thoughts" text,
	"description" text,
	"source_url" text,
	"primary_asset_id" text,
	"archived_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artwork_custom_field" (
	"id" text PRIMARY KEY NOT NULL,
	"artwork_id" text NOT NULL,
	"label" text NOT NULL,
	"value" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artwork_tag" (
	"artwork_id" text NOT NULL,
	"tag_id" text NOT NULL,
	CONSTRAINT "artwork_tag_artwork_id_tag_id_pk" PRIMARY KEY("artwork_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "gallery" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"cover_asset_id" text,
	"sort_mode" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gallery_artwork" (
	"gallery_id" text NOT NULL,
	"artwork_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gallery_artwork_gallery_id_artwork_id_pk" PRIMARY KEY("gallery_id","artwork_id")
);
--> statement-breakpoint
CREATE TABLE "media_asset" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"artwork_id" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"storage_path" text NOT NULL,
	"thumbnail_path" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork" ADD CONSTRAINT "artwork_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_custom_field" ADD CONSTRAINT "artwork_custom_field_artwork_id_artwork_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artwork"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_tag" ADD CONSTRAINT "artwork_tag_artwork_id_artwork_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artwork"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_tag" ADD CONSTRAINT "artwork_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery" ADD CONSTRAINT "gallery_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_artwork" ADD CONSTRAINT "gallery_artwork_gallery_id_gallery_id_fk" FOREIGN KEY ("gallery_id") REFERENCES "public"."gallery"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_artwork" ADD CONSTRAINT "gallery_artwork_artwork_id_artwork_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artwork"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_artwork_id_artwork_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artwork"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "artwork_user_id_idx" ON "artwork" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "artwork_primary_asset_id_idx" ON "artwork" USING btree ("primary_asset_id");--> statement-breakpoint
CREATE INDEX "artwork_custom_field_artwork_id_idx" ON "artwork_custom_field" USING btree ("artwork_id");--> statement-breakpoint
CREATE INDEX "artwork_tag_artwork_id_idx" ON "artwork_tag" USING btree ("artwork_id");--> statement-breakpoint
CREATE INDEX "artwork_tag_tag_id_idx" ON "artwork_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "gallery_user_id_idx" ON "gallery" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "gallery_artwork_gallery_id_idx" ON "gallery_artwork" USING btree ("gallery_id");--> statement-breakpoint
CREATE INDEX "gallery_artwork_artwork_id_idx" ON "gallery_artwork" USING btree ("artwork_id");--> statement-breakpoint
CREATE INDEX "media_asset_user_id_idx" ON "media_asset" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "media_asset_artwork_id_idx" ON "media_asset" USING btree ("artwork_id");--> statement-breakpoint
CREATE INDEX "tag_user_id_idx" ON "tag" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_user_slug_idx" ON "tag" USING btree ("user_id","slug");