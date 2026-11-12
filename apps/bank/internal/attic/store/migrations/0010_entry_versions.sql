-- Which contents an entry held, so what was read from earlier bytes stays
-- searchable after the file changes. The open row is the content the entry
-- holds now; replaced_scan is the scan that saw the bytes change.
create table entry_versions (
    id            bigint generated always as identity primary key,
    entry_id      bigint not null references entries,
    content_id    bigint not null references contents,
    size_bytes    bigint not null,
    modified_at   timestamptz,
    first_scan    bigint not null references scans,
    replaced_scan bigint references scans
);

-- Existing rows do not record which scan hashed their content. Their last
-- update is a scan known to have seen it.
insert into entry_versions (entry_id, content_id, size_bytes, modified_at, first_scan)
select id, content_id, size_bytes, modified_at, updated_scan from entries where content_id is not null order by id;

create unique index entry_versions_open_idx on entry_versions (entry_id) where replaced_scan is null;
create index entry_versions_entry_idx on entry_versions (entry_id, id);
create index entry_versions_content_idx on entry_versions (content_id);
