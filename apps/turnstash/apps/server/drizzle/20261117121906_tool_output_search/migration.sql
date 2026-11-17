DROP INDEX messages_bm25;--> statement-breakpoint
CREATE INDEX messages_bm25 ON messages USING bm25 (id, (text::pdb.source_code));--> statement-breakpoint
CREATE INDEX tool_executions_bm25 ON tool_executions USING bm25 (id, (output::pdb.source_code));--> statement-breakpoint
INSERT INTO dirty_conversations (provider, conversation_key)
SELECT provider, conversation_key FROM conversations
ON CONFLICT DO NOTHING;
