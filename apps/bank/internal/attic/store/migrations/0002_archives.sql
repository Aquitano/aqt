-- What archives hold. A listing belongs to the archive's content, so the same
-- zip on three disks is read once and a hit inside it shows all three copies.
create table archives (
    content_id bigint primary key references contents,
    -- zip | 7z | rar | tar | tar.gz ...; empty when the bytes are no archive.
    format     text not null default '',
    -- listed | damaged | encrypted | not_archive | split. A damaged archive
    -- keeps the members read before the damage.
    status     text not null,
    detail     text not null default '',
    members    bigint not null default 0,
    listed_at  timestamptz not null default now()
);

-- Members are never hashed: their bytes are only read to open nested archives.
create table members (
    id          bigint generated always as identity primary key,
    archive_id  bigint not null references archives,
    -- dir | file | link
    kind        text not null,
    name        text not null,
    -- Inside the archive and '/'-separated; ' :: ' steps into a nested archive.
    path        text not null,
    ext         text not null default '',
    size_bytes  bigint not null default 0,
    modified_at timestamptz,
    crc32       bigint,
    encrypted   boolean not null default false
);

create index members_archive_idx on members (archive_id);

-- The same fields as entries_bm25_idx, so one query builder serves both.
create index members_bm25_idx on members using bm25 (
    id,
    (name::pdb.source_code('ascii_folding=true')),
    (name::pdb.ngram(3, 3, 'alias=name_ngram', 'ascii_folding=true')),
    (path::pdb.source_code('ascii_folding=true'))
) with (key_field = 'id');

-- scans.status gains 'listing', between hashing and complete. Skips gain
-- too_deep, encrypted, damaged, not_archive and split; a skip inside an
-- archive has a path with ' :: '.
alter table scans
    add column archives bigint not null default 0,
    add column members  bigint not null default 0;
