INSERT INTO dirty_conversations (provider, conversation_key)
SELECT provider, conversation_key FROM conversations
ON CONFLICT DO NOTHING;
