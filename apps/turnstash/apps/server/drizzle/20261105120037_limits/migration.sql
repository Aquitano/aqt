CREATE TABLE "limit_hits" (
	"id" bigserial PRIMARY KEY,
	"provider" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"window_minutes" integer,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "limit_samples" (
	"id" bigserial PRIMARY KEY,
	"provider" text NOT NULL,
	"conversation_id" uuid,
	"window_minutes" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"used_percent" double precision NOT NULL,
	"resets_at" timestamp with time zone NOT NULL,
	"plan" text,
	CONSTRAINT "limit_samples_identity" UNIQUE NULLS NOT DISTINCT("provider","conversation_id","window_minutes","observed_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "limit_hits_identity" ON "limit_hits" ("conversation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "limit_hits_time" ON "limit_hits" ("provider","occurred_at");--> statement-breakpoint
CREATE INDEX "limit_samples_series" ON "limit_samples" ("provider","window_minutes","observed_at");--> statement-breakpoint
CREATE INDEX "limit_samples_conversation" ON "limit_samples" ("conversation_id");--> statement-breakpoint
ALTER TABLE "limit_hits" ADD CONSTRAINT "limit_hits_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "limit_samples" ADD CONSTRAINT "limit_samples_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;