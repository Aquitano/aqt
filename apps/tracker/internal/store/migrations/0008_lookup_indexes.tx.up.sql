-- Deleting a record or a url checks every referencing row, and forget and
-- the visit counts look rows up by these columns; without an index each is a
-- sequential scan. Small enough to build inside the migration's transaction,
-- which runs before serve listens. normalized_url keeps query strings, so a
-- btree on it would reject a URL past its 2704-byte row limit; the lookups
-- are equality only, which a hash index serves at any length.
create index if not exists derivations_record_idx on derivations (record_id);
create index if not exists records_url_idx on records (url_id);
create index if not exists page_views_referrer_idx on page_views (referrer_url_id);
create index if not exists urls_normalized_url_idx on urls using hash (normalized_url);
