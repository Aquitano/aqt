CREATE TYPE "job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "message_role" AS ENUM('user', 'assistant', 'system', 'tool');--> statement-breakpoint
CREATE TYPE "tool_status" AS ENUM('ok', 'error', 'unknown');--> statement-breakpoint
CREATE TYPE "usage_basis" AS ENUM('reported', 'cumulative_delta', 'estimated');--> statement-breakpoint
CREATE TABLE "annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"conversation_id" uuid NOT NULL,
	"producer" text NOT NULL,
	"kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversation_machines" (
	"conversation_id" uuid,
	"machine_id" uuid,
	CONSTRAINT "conversation_machines_pkey" PRIMARY KEY("conversation_id","machine_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider" text NOT NULL,
	"conversation_key" text NOT NULL,
	"parent_id" uuid,
	"parent_key" text,
	"title" text,
	"project_path" text,
	"project_key" text,
	"git_branch" text,
	"client_version" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"parser_version" integer NOT NULL,
	"normalized_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dirty_conversations" (
	"provider" text,
	"conversation_key" text,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dirty_conversations_pkey" PRIMARY KEY("provider","conversation_key")
);
--> statement-breakpoint
CREATE TABLE "ingest_batches" (
	"id" uuid PRIMARY KEY,
	"machine_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted" integer NOT NULL,
	"duplicates" integer NOT NULL,
	"replaced" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued'::"job_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"os" text NOT NULL,
	"arch" text NOT NULL,
	"token_hash" text NOT NULL,
	"agent_version" text,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"conversation_id" uuid NOT NULL,
	"message_key" text NOT NULL,
	"seq" integer NOT NULL,
	"role" "message_role" NOT NULL,
	"parent_message_key" text,
	"created_at" timestamp with time zone NOT NULL,
	"parts" jsonb NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"conversation_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"message_key" text,
	"request_key" text NOT NULL,
	"model_raw" text NOT NULL,
	"model_id" text NOT NULL,
	"route" text,
	"route_hint" text,
	"requested_at" timestamp with time zone NOT NULL,
	"input_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"cache_write_1h_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"reasoning_tokens" integer NOT NULL,
	"usage_basis" "usage_basis" NOT NULL,
	"speed" text,
	"source_record_key" text
);
--> statement-breakpoint
CREATE TABLE "pricing_catalogs" (
	"version" text PRIMARY KEY,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"entries" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_records" (
	"id" bigserial PRIMARY KEY,
	"stream_ref" bigint NOT NULL,
	"provider" text NOT NULL,
	"record_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"payload" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"redactions" integer DEFAULT 0 NOT NULL,
	"conversation_key" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_streams" (
	"id" bigserial PRIMARY KEY,
	"machine_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"stream_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"monthly_price" numeric(12,2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"started_on" date NOT NULL,
	"ended_on" date
);
--> statement-breakpoint
CREATE TABLE "tombstones" (
	"provider" text,
	"conversation_key" text,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	CONSTRAINT "tombstones_pkey" PRIMARY KEY("provider","conversation_key")
);
--> statement-breakpoint
CREATE TABLE "tool_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"conversation_id" uuid NOT NULL,
	"message_key" text,
	"tool_key" text NOT NULL,
	"name" text NOT NULL,
	"input" jsonb,
	"output" text,
	"status" "tool_status" NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "valuations" (
	"id" bigserial PRIMARY KEY,
	"request_id" uuid NOT NULL,
	"catalog_version" text NOT NULL,
	"price_key" text,
	"cost_usd" numeric(16,10),
	"unpriced_reason" text,
	"breakdown" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_identity" ON "conversations" ("provider","conversation_key");--> statement-breakpoint
CREATE INDEX "conversations_started" ON "conversations" ("started_at");--> statement-breakpoint
CREATE INDEX "conversations_project" ON "conversations" ("project_key");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_identity" ON "messages" ("conversation_id","message_key");--> statement-breakpoint
CREATE INDEX "messages_order" ON "messages" ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "model_requests_identity" ON "model_requests" ("conversation_id","request_key");--> statement-breakpoint
CREATE INDEX "model_requests_time" ON "model_requests" ("requested_at");--> statement-breakpoint
CREATE INDEX "model_requests_model" ON "model_requests" ("model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_identity" ON "source_records" ("stream_ref","record_key");--> statement-breakpoint
CREATE INDEX "source_records_conversation" ON "source_records" ("provider","conversation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "source_streams_identity" ON "source_streams" ("machine_id","provider","stream_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_executions_identity" ON "tool_executions" ("conversation_id","tool_key");--> statement-breakpoint
CREATE INDEX "valuations_request_active" ON "valuations" ("request_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "valuations_request_catalog" ON "valuations" ("request_id","catalog_version");--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_machines" ADD CONSTRAINT "conversation_machines_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_machines" ADD CONSTRAINT "conversation_machines_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "ingest_batches" ADD CONSTRAINT "ingest_batches_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "model_requests" ADD CONSTRAINT "model_requests_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_stream_ref_source_streams_id_fkey" FOREIGN KEY ("stream_ref") REFERENCES "source_streams"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_streams" ADD CONSTRAINT "source_streams_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "valuations" ADD CONSTRAINT "valuations_request_id_model_requests_id_fkey" FOREIGN KEY ("request_id") REFERENCES "model_requests"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "valuations" ADD CONSTRAINT "valuations_catalog_version_pricing_catalogs_version_fkey" FOREIGN KEY ("catalog_version") REFERENCES "pricing_catalogs"("version");