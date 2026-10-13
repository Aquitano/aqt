CREATE TABLE "conversation_turns" (
	"conversation_id" uuid,
	"turn_index" integer,
	"first_seq" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"user_excerpt" text NOT NULL,
	"category" text NOT NULL,
	"skill" text,
	"primary_model_id" text,
	"tools" text[] NOT NULL,
	"skills" text[] NOT NULL,
	"mcp_servers" text[] NOT NULL,
	"commands" text[] NOT NULL,
	"edits" integer NOT NULL,
	"retries" integer NOT NULL,
	"analysis_version" integer NOT NULL,
	CONSTRAINT "conversation_turns_pkey" PRIMARY KEY("conversation_id","turn_index")
);
--> statement-breakpoint
ALTER TABLE "model_requests" ADD COLUMN "turn_index" integer;--> statement-breakpoint
CREATE INDEX "conversation_turns_category" ON "conversation_turns" ("category");--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;