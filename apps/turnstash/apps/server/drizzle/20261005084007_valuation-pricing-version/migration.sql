ALTER TABLE "valuations" ADD COLUMN "pricing_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX "valuations_active_cost";--> statement-breakpoint
CREATE INDEX "valuations_active_cost" ON "valuations" ("request_id","cost_usd","pricing_version") WHERE "active";