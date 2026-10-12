DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search') THEN
    CREATE EXTENSION IF NOT EXISTS pg_search;
    CREATE INDEX IF NOT EXISTS messages_bm25 ON messages USING bm25 (id, text) WITH (key_field = 'id');
  ELSE
    CREATE INDEX IF NOT EXISTS messages_fts ON messages USING gin (to_tsvector('english', text));
  END IF;
END $$;
