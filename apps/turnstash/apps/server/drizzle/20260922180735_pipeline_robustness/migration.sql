ALTER TABLE "dirty_conversations" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pricing_catalogs" ADD COLUMN "recompute_from" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_token_hash" ON "api_tokens" ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "machines_token_hash" ON "machines" ("token_hash");