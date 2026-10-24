-- A retired message keeps its identity here after its row is deleted: imports
-- skip a tombstoned (source, external_id), and its ref still resolves to what
-- it was and to the record that replaced it.
create table message_tombstones (
    source      text not null,
    external_id text not null,
    ref         text not null,
    sent_at     timestamptz not null,
    subject     text not null default '',
    raw_ref     text not null default '',
    reason      text not null default '',
    replacement text not null default '',
    retired_at  timestamptz not null default now(),
    primary key (source, external_id)
);
create index message_tombstones_ref on message_tombstones (ref);
