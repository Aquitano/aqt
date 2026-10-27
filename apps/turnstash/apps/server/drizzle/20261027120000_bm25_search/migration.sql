CREATE EXTENSION IF NOT EXISTS pg_search;--> statement-breakpoint
DROP INDEX IF EXISTS messages_fts;--> statement-breakpoint
DROP INDEX IF EXISTS messages_bm25;--> statement-breakpoint
CREATE INDEX messages_bm25 ON messages USING bm25 (id, (text::pdb.simple));
