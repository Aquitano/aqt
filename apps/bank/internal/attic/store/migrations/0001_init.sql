-- attic's catalogue. DESIGN.md explains the three identities: volumes by
-- fingerprint, contents by BLAKE3, entries by NTFS file id or by path.

create table volumes (
    id            uuid primary key default gen_random_uuid(),
    label         text not null default '',
    fs_type       text not null,
    serial        text not null,
    partition_id  text not null default '',
    device_serial text not null default '',
    size_bytes    bigint not null default 0,
    stable_ids    boolean not null,
    -- Where the volume was last mounted, for display only.
    mount_path    text not null default '',
    first_seen    timestamptz not null default now(),
    last_seen     timestamptz not null default now()
);

create index volumes_serial_idx on volumes (fs_type, serial);

create table contents (
    id         bigint generated always as identity primary key,
    blake3     bytea not null unique,
    size_bytes bigint not null,
    first_seen timestamptz not null default now()
);

-- A ref is the first eight bytes of the digest, printed as 16 hex characters.
create index contents_ref_idx on contents (substr(blake3, 1, 8));

create table scans (
    id           bigint generated always as identity primary key,
    volume_id    uuid not null references volumes,
    -- The scanned folder, volume-relative like entries.path.
    root         text not null,
    -- walking | hashing | complete | interrupted | failed
    status       text not null,
    started_at   timestamptz not null default now(),
    finished_at  timestamptz,
    listed       bigint not null default 0,
    written      bigint not null default 0,
    missing      bigint not null default 0,
    skipped      bigint not null default 0,
    hashed       bigint not null default 0,
    hashed_bytes bigint not null default 0,
    duplicates   bigint not null default 0,
    error        text not null default ''
);

create table entries (
    id           bigint generated always as identity primary key,
    volume_id    uuid not null references volumes,
    parent_id    bigint references entries,
    -- dir | file | link
    kind         text not null,
    name         text not null,
    -- Volume-relative and '/'-separated: '' is the root, '/Files/x.zip' a file.
    -- Stored on every row because search ranks path words with the name.
    path         text not null,
    ext          text not null default '',
    -- The NTFS file reference number. Null on file systems without stable ids,
    -- where the path is the identity instead.
    file_id      bigint,
    size_bytes   bigint not null default 0,
    created_at   timestamptz,
    modified_at  timestamptz,
    accessed_at  timestamptz,
    changed_at   timestamptz,
    attributes   integer not null default 0,
    content_id   bigint references contents,
    -- Files: pending | done | skipped | failed. Folders and links: none.
    hash_state   text not null,
    git_remote   text,
    -- Set when a complete listing of the parent folder no longer found it.
    missing_scan bigint references scans,
    -- Folders: the last scan that read this folder completely.
    listed_scan  bigint references scans,
    first_scan   bigint not null references scans,
    updated_scan bigint not null references scans
) with (fillfactor = 80);
-- The fill factor leaves room on each page, so rewriting accessed_at or
-- listed_scan stays a heap-only update and does not touch the BM25 index.

create unique index entries_file_id_idx on entries (volume_id, file_id) where file_id is not null;
create unique index entries_path_identity_idx on entries (parent_id, name) where file_id is null;
create unique index entries_root_idx on entries (volume_id) where parent_id is null;
create index entries_parent_idx on entries (parent_id);
create index entries_content_idx on entries (content_id);
-- Byte order makes a subtree a range: everything under P sorts between
-- P || '/' and P || '0', the next character after '/'.
create index entries_path_idx on entries (volume_id, path collate "C");
create index entries_hash_queue_idx on entries (volume_id, path collate "C")
    where hash_state in ('pending', 'failed');

-- source_code splits MinecraftServer and pingpong_final into words; the
-- trigram field finds fragments such as "werkstudent" inside
-- Werkstudentenvertrag. ascii_folding lets "fur" find "für".
create index entries_bm25_idx on entries using bm25 (
    id,
    (name::pdb.source_code('ascii_folding=true')),
    (name::pdb.ngram(3, 3, 'alias=name_ngram', 'ascii_folding=true')),
    (path::pdb.source_code('ascii_folding=true'))
) with (key_field = 'id');

create table skips (
    id      bigint generated always as identity primary key,
    scan_id bigint not null references scans on delete cascade,
    path    text not null,
    -- excluded | name_only | too_big | link | remote | unreadable | changed
    reason  text not null,
    rule    text not null default '',
    detail  text not null default ''
);

create index skips_scan_idx on skips (scan_id, reason);
