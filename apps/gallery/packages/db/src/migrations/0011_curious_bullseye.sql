CREATE TABLE "personal_collection" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_collection_artwork" (
	"collection_id" text NOT NULL,
	"artwork_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "personal_collection_artwork_collection_id_artwork_id_pk" PRIMARY KEY("collection_id","artwork_id")
);
--> statement-breakpoint
CREATE TABLE "visit" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"venue_name" text,
	"city" text,
	"country" text,
	"address" text,
	"latitude" real,
	"longitude" real,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"notes" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_artwork" (
	"visit_id" text NOT NULL,
	"artwork_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"note" text,
	CONSTRAINT "visit_artwork_visit_id_artwork_id_pk" PRIMARY KEY("visit_id","artwork_id")
);
--> statement-breakpoint
ALTER TABLE "personal_collection_artwork" ADD CONSTRAINT "personal_collection_artwork_collection_id_personal_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."personal_collection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_collection_artwork" ADD CONSTRAINT "personal_collection_artwork_artwork_id_artwork_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artwork"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_artwork" ADD CONSTRAINT "visit_artwork_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_artwork" ADD CONSTRAINT "visit_artwork_artwork_id_artwork_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artwork"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "personal_collection_user_slug_idx" ON "personal_collection" USING btree ("user_id","slug");--> statement-breakpoint
CREATE INDEX "personal_collection_user_updated_idx" ON "personal_collection" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "personal_collection_artwork_artwork_id_idx" ON "personal_collection_artwork" USING btree ("artwork_id");--> statement-breakpoint
CREATE INDEX "visit_user_started_idx" ON "visit" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "visit_user_id_idx" ON "visit" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "visit_artwork_artwork_id_idx" ON "visit_artwork" USING btree ("artwork_id");