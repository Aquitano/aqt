CREATE INDEX tool_executions_bm25 ON tool_executions USING bm25 (id, (output::pdb.simple));--> statement-breakpoint
INSERT INTO dirty_conversations (provider, conversation_key)
SELECT provider, conversation_key FROM conversations
ON CONFLICT DO NOTHING;
