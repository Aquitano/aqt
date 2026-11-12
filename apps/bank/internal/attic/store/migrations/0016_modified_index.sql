-- The timeline lists present files by modification time.
create index entries_modified_idx on entries (modified_at, id)
    where kind = 'file' and missing_scan is null and modified_at is not null;
