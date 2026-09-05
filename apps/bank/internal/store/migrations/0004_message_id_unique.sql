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

-- What each survivor held before the merge. A message may legitimately carry
-- the same file twice under the same name — syncAttachments preserves that on
-- purpose — so the dedup below must not mistake its own second copy for one
-- the merge brought in.
create temporary table survivor_attachments on commit drop as
select a.message_id, a.sha256, a.filename, count(*) as copies
from attachments a
where a.message_id in (select survivor from message_id_dupes where id <> survivor)
group by a.message_id, a.sha256, a.filename;

-- The ids that actually move, captured while they can still be identified.
create temporary table moved_attachments on commit drop as
select a.id, d.survivor
from attachments a
join message_id_dupes d on d.id = a.message_id
where d.id <> d.survivor;

update attachments a
set message_id = d.survivor
from message_id_dupes d
where a.message_id = d.id and d.id <> d.survivor;

-- Only moved rows may go, and only as many of them as the survivor already
-- had copies of that file: with one loser this leaves the larger of the two
-- counts, which is what the message really carried.
delete from attachments a
using (
    select m.id,
           row_number() over (partition by m.survivor, att.sha256, att.filename order by m.id) as moved_rank,
           s.copies
    from moved_attachments m
    join attachments att on att.id = m.id
    join survivor_attachments s
      on s.message_id = m.survivor and s.sha256 = att.sha256 and s.filename = att.filename
) dup
where a.id = dup.id and dup.moved_rank <= dup.copies;

-- The delete below is irreversible and runs unattended at every store.Open,
-- so the losing rows are copied out first: what vanished stays reviewable and
-- the raw archive files they name stay reachable.
create table if not exists message_id_collapsed (
    id             bigint primary key,
    source         text not null,
    external_id    text not null,
    message_id     text not null,
    sender         text not null default '',
    subject        text not null default '',
    sent_at        timestamptz not null,
    raw_ref        text not null default '',
    collapsed_into bigint not null,
    collapsed_at   timestamptz not null default now()
);

insert into message_id_collapsed
    (id, source, external_id, message_id, sender, subject, sent_at, raw_ref, collapsed_into)
select m.id, m.source, m.external_id, m.message_id, m.sender, m.subject, m.sent_at, m.raw_ref, d.survivor
from messages m
join message_id_dupes d on d.id = m.id
where d.id <> d.survivor
on conflict (id) do nothing;

delete from messages m
using message_id_dupes d
where m.id = d.id and d.id <> d.survivor;

create unique index if not exists messages_source_message_id_key
    on messages (source, message_id) where message_id <> '';
