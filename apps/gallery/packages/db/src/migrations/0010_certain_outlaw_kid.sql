CREATE TABLE "museum_stat" (
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"metric" text NOT NULL,
	"artwork_id" text DEFAULT '' NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "museum_stat_unique_idx" ON "museum_stat" USING btree ("entity_kind","entity_id","metric","artwork_id","day");--> statement-breakpoint
CREATE INDEX "museum_stat_entity_idx" ON "museum_stat" USING btree ("entity_kind","entity_id");