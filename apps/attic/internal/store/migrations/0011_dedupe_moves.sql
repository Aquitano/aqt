-- A copy dedupe moved into its disk's quarantine folder. The entry stays, so
-- the catalogue still says where the copy was and which copy was kept.
create table dedupe_moves (
    entry_id      bigint primary key references entries,
    kept_entry_id bigint not null references entries,
    content_id    bigint not null references contents,
    moved_to      text not null,
    moved_at      timestamptz not null default now()
);
