ALTER TABLE "messages" ADD COLUMN "turn_index" integer;--> statement-breakpoint
CREATE INDEX "messages_turn_order" ON "messages" ("conversation_id","turn_index","seq");