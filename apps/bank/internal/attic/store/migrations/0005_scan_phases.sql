-- How long each phase of a scan took, so a slow disk, archive or document
-- stage shows in the scan history and not only in its log.
alter table scans
    add column walk_ms     bigint not null default 0,
    add column hash_ms     bigint not null default 0,
    add column archives_ms bigint not null default 0,
    add column text_ms     bigint not null default 0;
