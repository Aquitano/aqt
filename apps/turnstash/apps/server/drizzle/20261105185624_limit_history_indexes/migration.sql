DROP INDEX "limit_samples_series";--> statement-breakpoint
DROP INDEX "limit_hits_time";--> statement-breakpoint
CREATE INDEX "limit_hits_time" ON "limit_hits" ("occurred_at");--> statement-breakpoint
CREATE INDEX "limit_samples_window" ON "limit_samples" ("window_minutes");--> statement-breakpoint
CREATE INDEX "limit_samples_observed" ON "limit_samples" ("observed_at");--> statement-breakpoint
CREATE INDEX "limit_samples_reset" ON "limit_samples" ("resets_at");