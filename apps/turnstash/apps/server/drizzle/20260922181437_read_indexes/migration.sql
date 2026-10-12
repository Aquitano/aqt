DROP INDEX "valuations_request_active";--> statement-breakpoint
CREATE INDEX "messages_created" ON "messages" ("created_at");--> statement-breakpoint
CREATE INDEX "valuations_active_cost" ON "valuations" ("request_id","cost_usd") WHERE "active";