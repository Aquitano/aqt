-- Make Message-ID dedup structural: the advisory check-then-insert in
-- eml.Ingest is racy under the sync's concurrent workers. InsertMessage uses
-- a bare "on conflict do nothing", so violations skip silently.
--
-- Databases filled under the previous schema can already hold duplicates, and
-- a bare create-unique-index would then fail on every startup, taking the
-- whole CLI down. Collapse them first. The survivor is the lowest id — the
-- copy ingested first — and its attachments absorb the losers' rows before
-- the losers are deleted, so the cascade cannot orphan anything.
drop index if exists messages_message_id_idx;

create temporary table message_id_dupes on commit drop as
select id, min(id) over (partition by source, message_id) as survivor
from messages
where message_id <> '';

update attachments a
set message_id = d.survivor
from message_id_dupes d
where a.message_id = d.id and d.id <> d.survivor;

-- The move can make two attachment rows on the survivor identical in both
-- content and name; keep one.
delete from attachments a
using attachments b
where a.message_id = b.message_id
  and a.sha256 = b.sha256
  and a.filename = b.filename
  and a.id > b.id
  and a.message_id in (select survivor from message_id_dupes where id <> survivor);

delete from messages m
using message_id_dupes d
where m.id = d.id and d.id <> d.survivor;

create unique index if not exists messages_source_message_id_key
    on messages (source, message_id) where message_id <> '';
