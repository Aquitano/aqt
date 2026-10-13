-- Deleting a record or a url checks every referencing row, and forget and
-- the visit counts look rows up by these columns; without an index each is a
-- sequential scan. Small enough to build inside the migration's transaction,
-- which runs before serve listens.
create index if not exists derivations_record_idx on derivations (record_id);
create index if not exists records_url_idx on records (url_id);
create index if not exists page_views_referrer_idx on page_views (referrer_url_id);
create index if not exists urls_normalized_url_idx on urls (normalized_url);
