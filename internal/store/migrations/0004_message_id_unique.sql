-- Make Message-ID dedup structural: the advisory check-then-insert in
-- eml.Ingest is racy under the sync's concurrent workers. InsertMessage uses
-- a bare "on conflict do nothing", so violations skip silently.
drop index messages_message_id_idx;
create unique index messages_source_message_id_key on messages (source, message_id) where message_id <> '';
